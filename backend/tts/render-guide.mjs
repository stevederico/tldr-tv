/**
 * Kokoro entry point for the Rust server.
 *
 * `node render-guide.mjs wav` reads JSON on stdin and writes one JSON line
 * with base64 WAV. `node render-guide.mjs guide <out.mp3>` writes PROGRESS
 * lines, streams PCM through one continuous ffmpeg MP3 encoder into
 * `<partsDir>/stream.mp3` (+ state.json / timing.json sidecars), then a
 * RESULT line and the canonical MP3 at the given path.
 */
import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { synthesize, KOKORO_SAMPLE_RATE } from './kokoro.js';
import { synthesizeGuide } from './tts-pipeline.js';

const mode = process.argv[2];
const outPath = process.argv[3];
const input = JSON.parse(readFileSync(0, 'utf8'));

/** 64kbps CBR mono ≈ 8000 bytes of MP3 per second of audio. */
const MP3_BYTES_PER_SEC = 8000;
/** Max time to wait for ffmpeg to flush one chunk's worth of MP3 to disk. */
const ENCODER_FLUSH_TIMEOUT_MS = 8000;
/** Poll interval while waiting for stream.mp3 to grow after a PCM write. */
const ENCODER_FLUSH_POLL_MS = 40;

/**
 * Expected on-disk MP3 size for a cumulative PCM payload at 64kbps mono.
 * Uses 85% of theoretical CBR size so a partial last frame doesn't hang the wait.
 *
 * @param {number} pcmBytes
 * @param {number} sampleRate
 * @returns {number}
 */
export function expectedStreamMp3Bytes(pcmBytes, sampleRate) {
  if (pcmBytes <= 0 || sampleRate <= 0) return 0;
  const durationSec = pcmBytes / 2 / sampleRate;
  return Math.floor(durationSec * MP3_BYTES_PER_SEC * 0.85);
}

/** Best-effort file size; 0 when missing. */
function streamFileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Write streaming state (best-effort). */
function writeTtsState(partsDir, state) {
  try {
    writeFileSync(resolve(partsDir, 'state.json'), JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

/** Write partial timing sidecar (best-effort). */
function writeTtsTiming(partsDir, timing) {
  try {
    writeFileSync(resolve(partsDir, 'timing.json'), JSON.stringify(timing));
  } catch {
    /* best-effort */
  }
}

/**
 * One long-lived ffmpeg: raw PCM in, continuous MP3 out to `streamFile`.
 *
 * @param {string} streamFile
 */
function createTtsStreamEncoder(streamFile) {
  const ff = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-f', 's16le', '-ar', String(KOKORO_SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
    '-codec:a', 'libmp3lame', '-b:a', '64k', '-ac', '1',
    '-flush_packets', '1',
    '-f', 'mp3', 'pipe:1',
  ]);
  const out = createWriteStream(streamFile, { highWaterMark: 16 * 1024 });
  ff.stdout.pipe(out);
  ff.stderr.on('data', () => {});
  ff.on('error', () => {});
  ff.stdin.on('error', () => {});
  ff.stdout.on('error', () => {});
  out.on('error', () => {});

  let pcmWritten = 0;

  function writeStdin(pcm) {
    return new Promise((res) => {
      if (!ff.stdin.writable) return res();
      if (ff.stdin.write(pcm)) res();
      else ff.stdin.once('drain', res);
    });
  }

  async function waitForDisk(targetBytes) {
    const deadline = Date.now() + ENCODER_FLUSH_TIMEOUT_MS;
    while (streamFileSize(streamFile) < targetBytes && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, ENCODER_FLUSH_POLL_MS));
    }
  }

  return {
    write: async (pcm) => {
      await writeStdin(pcm);
      pcmWritten += pcm.length;
      await waitForDisk(expectedStreamMp3Bytes(pcmWritten, KOKORO_SAMPLE_RATE));
    },
    end: () =>
      new Promise((res) => {
        out.on('close', () => res());
        out.on('error', () => res());
        ff.on('error', () => res());
        ff.stdin.end();
      }),
    kill: () => {
      try {
        ff.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    },
  };
}

if (mode === 'wav') {
  const { audioWav, words, sampleRate, durationSec } = await synthesize(input.text, {
    voice: input.voice || 'af_heart',
    speed: input.speed || 1,
  });
  process.stdout.write(`${JSON.stringify({
    audioBase64: Buffer.from(audioWav).toString('base64'),
    mimeType: 'audio/wav',
    sampleRate,
    durationSec,
    words,
  })}\n`);
} else if (mode === 'guide') {
  const partsDir = input.partsDir
    ? String(input.partsDir)
    : resolve(dirname(outPath), `${outPath.replace(/\.mp3$/, '').split('/').pop()}.parts`);
  let encoder = null;
  const state = { chunksTotal: 0, chunksDone: 0, done: false, failed: false };
  try {
    rmSync(partsDir, { recursive: true, force: true });
    mkdirSync(partsDir, { recursive: true });
    writeTtsState(partsDir, state);
    const streamFile = resolve(partsDir, 'stream.mp3');
    const enc = createTtsStreamEncoder(streamFile);
    encoder = enc;

    const result = await synthesizeGuide({
      transcript: input.transcript,
      voice: input.voice || 'af_heart',
      speed: input.speed || 1,
      onProgress: (progress) => {
        process.stdout.write(`PROGRESS ${JSON.stringify(progress)}\n`);
      },
      onChunk: async (pcm, { index, chunksTotal, words, transcript: normalized }) => {
        await enc.write(pcm);
        writeTtsTiming(partsDir, { words, transcript: normalized });
        state.chunksTotal = chunksTotal;
        state.chunksDone = index + 1;
        writeTtsState(partsDir, state);
      },
    });

    await enc.end();
    writeFileSync(outPath, result.audioMp3);
    state.done = true;
    writeTtsState(partsDir, state);
    process.stdout.write(`RESULT ${JSON.stringify({
      durationSec: result.totalDuration,
      words: result.words,
      transcript: result.transcript,
    })}\n`);
  } catch (err) {
    encoder?.kill();
    writeTtsState(partsDir, { ...state, failed: true });
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write('usage: render-guide.mjs wav|guide [out.mp3]\n');
  process.exit(2);
}
