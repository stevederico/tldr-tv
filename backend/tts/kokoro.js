// Kokoro TTS — text → {WAV bytes, per-word timestamps}.
//
// Wraps the timestamped ONNX export of Kokoro-82M:
//   onnx-community/Kokoro-82M-v1.0-ONNX-timestamped
// which adds a `durations` output tensor on top of the standard `waveform`
// (one entry per input token, in 25ms frames).
//
// Voice style embeddings (510 rows × 256 floats) are downloaded per-voice
// from the same HF repo and cached on disk under tts/models/voices/.

import ort from 'onnxruntime-node';
import { phonemize } from 'phonemizer';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizePhonemes } from './vocab.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(__dirname, './models');
const MODEL_PATH = resolve(MODELS_DIR, 'kokoro-timestamped.onnx');
const VOICES_DIR = resolve(MODELS_DIR, 'voices');

const HF_BASE = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/main';
const MODEL_URL = `${HF_BASE}/onnx/model.onnx`;
const VOICE_URL = (voice) => `${HF_BASE}/voices/${voice}.bin`;

const SAMPLE_RATE = 24000;  // model output rate
const FRAME_RATE = 40;       // duration frames per second
const STYLE_DIM = 256;
const STYLE_ROWS = 510;      // rows in each voice .bin file

let session = null;
let sessionPromise = null;
const voiceCache = new Map(); // voice name -> Float32Array (full 510*256 buffer)

/**
 * Ensure a file exists on disk; download from `url` if missing. Creates parent dir.
 *
 * @param {string} path - Absolute destination path
 * @param {string} url - Source URL
 * @returns {Promise<void>}
 */
async function ensureFile(path, url) {
  try { await stat(path); return; } catch {}
  await mkdir(dirname(path), { recursive: true });
  console.log(`[tts] downloading ${url} → ${path}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path, buf);
}

/**
 * Lazy-load the ONNX session once. Subsequent calls return the cached session.
 *
 * @returns {Promise<ort.InferenceSession>}
 */
async function getSession() {
  if (session) return session;
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    await ensureFile(MODEL_PATH, MODEL_URL);
    const s = await ort.InferenceSession.create(MODEL_PATH);
    session = s;
    return s;
  })();
  return sessionPromise;
}

/**
 * Lazy-load a voice embedding (.bin file → Float32Array of 510 × 256 floats).
 *
 * @param {string} voice - Voice name (e.g. 'af_heart')
 * @returns {Promise<Float32Array>}
 */
async function getVoice(voice) {
  if (voiceCache.has(voice)) return voiceCache.get(voice);
  const path = resolve(VOICES_DIR, `${voice}.bin`);
  await ensureFile(path, VOICE_URL(voice));
  const buf = await readFile(path);
  const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  voiceCache.set(voice, arr);
  return arr;
}

/**
 * Encode a Float32 audio array as a 16-bit PCM WAV file.
 *
 * @param {Float32Array} samples - Mono audio in [-1, 1]
 * @param {number} sampleRate
 * @returns {Buffer} WAV file bytes
 */
function floatToWav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((v * 32767) | 0, 44 + i * 2);
  }
  return buf;
}

/**
 * Concatenate multiple 16-bit PCM mono WAVs with an equal-power crossfade at
 * every boundary. Eliminates the audible click/pop that you get from raw
 * concatenation, where the last sample of chunk N rarely aligns with the
 * first sample of chunk N+1.
 *
 * Crossfade length defaults to 25ms — short enough to be inaudible, long
 * enough to mask the transition. Chunks shorter than 2× the crossfade fall
 * back to butt-joining (no fade) to avoid eating the entire chunk.
 *
 * @param {Buffer[]} wavBuffers - WAV buffers from `floatToWav` / `synthesize`
 * @param {number} sampleRate - Sample rate (must match all inputs)
 * @param {Object} [opts]
 * @param {number} [opts.fadeMs=25] - Crossfade length per boundary
 * @returns {Buffer} Concatenated WAV file bytes
 */
export function concatWav(wavBuffers, sampleRate, { fadeMs = 25 } = {}) {
  if (!wavBuffers.length) throw new Error('concatWav: no buffers');
  if (wavBuffers.length === 1) return wavBuffers[0];

  // Decode each chunk's PCM into Int16Array views (no copy).
  const samples = wavBuffers.map(b => {
    const pcm = b.subarray(44);
    return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  });

  const fadeSamples = Math.max(1, Math.floor((fadeMs / 1000) * sampleRate));

  // Worst-case output length (no overlap). We'll trim to actual at the end.
  const maxTotal = samples.reduce((n, s) => n + s.length, 0);
  const out = new Int16Array(maxTotal);

  // Copy the first chunk wholesale.
  out.set(samples[0], 0);
  let writeIdx = samples[0].length;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const fade = Math.min(fadeSamples, prev.length >> 1, curr.length >> 1);

    if (fade < 8) {
      // Tiny chunk — just butt-join.
      out.set(curr, writeIdx);
      writeIdx += curr.length;
      continue;
    }

    // Equal-power crossfade: tail of prev (already at writeIdx-fade..writeIdx)
    // mixes with head of curr.
    const xStart = writeIdx - fade;
    for (let j = 0; j < fade; j++) {
      const t = (j + 1) / (fade + 1);          // 0..1 excluding endpoints
      const gPrev = Math.cos(t * Math.PI / 2); // 1 → 0
      const gCurr = Math.sin(t * Math.PI / 2); // 0 → 1
      const mixed = out[xStart + j] * gPrev + curr[j] * gCurr;
      out[xStart + j] = Math.max(-32768, Math.min(32767, mixed | 0));
    }
    // Copy the rest of curr after the fade region.
    out.set(curr.subarray(fade), writeIdx);
    writeIdx += curr.length - fade;
  }

  const totalPcmBytes = writeIdx * 2;
  const file = Buffer.alloc(44 + totalPcmBytes);
  file.write('RIFF', 0); file.writeUInt32LE(36 + totalPcmBytes, 4);
  file.write('WAVE', 8); file.write('fmt ', 12);
  file.writeUInt32LE(16, 16); file.writeUInt16LE(1, 20); file.writeUInt16LE(1, 22);
  file.writeUInt32LE(sampleRate, 24); file.writeUInt32LE(sampleRate * 2, 28);
  file.writeUInt16LE(2, 32); file.writeUInt16LE(16, 34);
  file.write('data', 36); file.writeUInt32LE(totalPcmBytes, 40);
  // Copy Int16Array bytes into the file buffer.
  Buffer.from(out.buffer, out.byteOffset, totalPcmBytes).copy(file, 44);
  return file;
}

export const KOKORO_SAMPLE_RATE = SAMPLE_RATE;

/**
 * Build a silent WAV buffer of the given duration. Used by the pipeline to
 * insert explicit breaths at sentence / paragraph seams that the chunker
 * would otherwise butt-join (Kokoro emits ~150ms of prosodic pause for `.`
 * mid-chunk; cross-chunk boundaries get none without padding).
 *
 * @param {number} durationSec - Length of silence in seconds
 * @param {number} sampleRate - Sample rate (should match audio chunks)
 * @returns {Buffer} WAV file bytes
 */
export function silenceWav(durationSec, sampleRate = SAMPLE_RATE) {
  const n = Math.max(0, Math.round(durationSec * sampleRate));
  return floatToWav(new Float32Array(n), sampleRate);
}

/**
 * Encode a WAV buffer to MP3 (mono, 64kbps) via ffmpeg/libmp3lame. Requires
 * `ffmpeg` on PATH. Speech-tuned: 64k mono is transparent for single-voice
 * narration and 6× smaller than 24kHz/16-bit PCM, keeping long guides under
 * GitHub's 100MB per-file limit.
 *
 * @param {Buffer} wavBuf - WAV file bytes
 * @param {Object} [opts]
 * @param {boolean} [opts.xing=true] - Write the Xing/LAME info header frame.
 *   Pass `false` for per-chunk encodes that get concatenated into a live
 *   stream: each Xing frame decodes to a near-silent frame, so dropping it on
 *   every chunk but the first avoids repeated header frames mid-stream (fewer
 *   seam artifacts). The canonical single-shot encode keeps it (default).
 * @returns {Promise<Buffer>} MP3 file bytes
 */
export function wavToMp3(wavBuf, { xing = true } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'wav', '-i', 'pipe:0',
      '-codec:a', 'libmp3lame', '-b:a', '64k', '-ac', '1',
      ...(xing ? [] : ['-write_xing', '0']),
      '-f', 'mp3', 'pipe:1',
    ]);
    const out = [];
    const err = [];
    ff.stdout.on('data', d => out.push(d));
    ff.stderr.on('data', d => err.push(d));
    ff.on('error', reject);
    ff.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString()}`));
      resolve(Buffer.concat(out));
    });
    ff.stdin.end(wavBuf);
  });
}

/**
 * Pick the style vector matching the current input length.
 *
 * Kokoro stores 510 style vectors per voice; the one at index `min(max(L-2, 0), 509)`
 * is the right embedding for an input of L tokens (including BOS/EOS).
 *
 * @param {Float32Array} voiceBuf
 * @param {number} idsLen
 * @returns {Float32Array} 256-element style vector
 */
function pickStyle(voiceBuf, idsLen) {
  const row = Math.min(Math.max(idsLen - 2, 0), STYLE_ROWS - 1);
  return voiceBuf.slice(row * STYLE_DIM, row * STYLE_DIM + STYLE_DIM);
}

/**
 * Build per-character cumulative start times in seconds.
 *
 * `durations[i]` corresponds to `input_ids[i]`. Index 0 is BOS, so the first
 * phoneme char (index 0 of phStr) maps to durations[1], and so on.
 *
 * @param {Float32Array|Int32Array} durations - Per-token frame counts (length = ids.length)
 * @param {number} phLen - Number of phoneme chars (= ids.length - 2)
 * @returns {number[]} charTimes[i] = start time of the i-th phoneme char in seconds.
 *                    Length is phLen + 1 (the last entry is the end of the last char).
 */
function buildCharTimes(durations, phLen) {
  const times = new Array(phLen + 1);
  let cum = Number(durations[0]); // skip BOS into the start time
  for (let i = 0; i < phLen; i++) {
    times[i] = cum / FRAME_RATE;
    cum += Number(durations[i + 1]);
  }
  times[phLen] = cum / FRAME_RATE;
  return times;
}

/**
 * Generate speech for `text` and return WAV bytes plus per-word timestamps.
 *
 * Phonemization is per-clause (split on punctuation), reassembled with the
 * original punctuation chars between clauses so Kokoro's vocab tokens for
 * `, . ; : ! ? — …` reach the model and trigger its learned pause durations
 * — the `phonemizer` npm strips them otherwise, which makes sentences run
 * together. Word alignment skips punctuation chars when matching per-word
 * IPA against the whole-text IPA stream.
 *
 * @param {string} text - Text to speak
 * @param {Object} [opts]
 * @param {string} [opts.voice='af_heart'] - One of Kokoro's 28 supported voices
 * @param {number} [opts.speed=1] - Speech rate; 1 = natural
 * @returns {Promise<{audioWav: Buffer, words: Array<{w: string, t: number}>, sampleRate: number, durationSec: number}>}
 */
// Kokoro vocab includes explicit punctuation tokens (`,` `.` `;` `:` `!` `?`
// `—` `…`) with learned pause durations. The `phonemizer` npm package strips
// ALL punctuation on output ("Hello, world." → ["həlˈoʊ", "wˈɜːld"]) so the
// model never sees them and the pauses never fire — sentences run together.
// To preserve punctuation, split text at every punctuation mark, phonemize
// each clause separately (coarticulation within a clause is preserved; the
// coarticulation lost at punctuation boundaries doesn't matter because a
// natural pause breaks coarticulation there anyway), and re-assemble with
// the original punctuation chars interleaved between clauses.
const PAUSE_PUNCT_GLOBAL = /([.,!?;:…—]+)/g;
const KOKORO_PUNCT_SET = new Set([',', '.', '!', '?', ';', ':', '…', '—']);

async function phonemizeWithPunctuation(text, lang = 'en-us') {
  const parts = text.split(PAUSE_PUNCT_GLOBAL);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i % 2 === 0) {
      const seg = part.trim();
      if (!seg) continue;
      const r = await phonemize(seg, lang);
      const ph = (Array.isArray(r) ? r.join(' ') : String(r)).trim();
      if (ph) out.push(ph);
    } else {
      // Keep only vocab-known punctuation chars (drop runs of repeats too;
      // `...` already collapses to `…` if present, but `..` stays as `..`
      // which Kokoro treats as two `.` tokens — fine for an extra-long pause).
      const punct = [...part].filter(c => KOKORO_PUNCT_SET.has(c)).join('');
      if (punct) out.push(punct);
    }
  }
  return out.join(' ').trim();
}

export async function synthesize(text, { voice = 'af_heart', speed = 1 } = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('synthesize: empty text');

  // 1. Phonemize the WHOLE chunk, preserving punctuation tokens so Kokoro
  // applies its learned pause durations. See phonemizeWithPunctuation above.
  // Per-word phonemize was banned for killing coarticulation; per-clause is
  // safe because punctuation already breaks coarticulation in real speech.
  const inputWords = trimmed.split(/\s+/).filter(Boolean);
  const phStr = await phonemizeWithPunctuation(trimmed, 'en-us');

  // For timing alignment we still need to know each word's IPA so we can find
  // where it lives inside phStr. Run a second per-word phonemize pass — used
  // ONLY for the substring-match offsets, never fed to the model.
  const ipaWords = await Promise.all(
    inputWords.map(async (w) => {
      const r = await phonemize(w, 'en-us');
      return (Array.isArray(r) ? r.join(' ') : String(r)).trim();
    })
  );

  // 2. Tokenize → input_ids
  const ids = await tokenizePhonemes(phStr);
  const phChars = [...phStr]; // code-point split; length should equal ids.length - 2

  // 3. Pick style vector + load model
  const [voiceBuf, sess] = await Promise.all([getVoice(voice), getSession()]);
  const style = pickStyle(voiceBuf, ids.length);

  // 4. Build ONNX inputs
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    style: new ort.Tensor('float32', style, [1, STYLE_DIM]),
    speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
  };

  // 5. Run inference
  const out = await sess.run(feeds);
  const wave = out.waveform.data; // Float32Array
  const durations = out.durations.data; // Float32Array or similar

  // 6. Build per-char start times
  const charTimes = buildCharTimes(durations, phChars.length);

  // 7. Align input words to whole-text IPA tokens.
  //
  // Why not substring-search per-word IPA in phStr: espeak emits primary stress
  // (ˈ) on isolated words but drops it for unstressed words in a sentence
  // ("ðˈɛɹ" alone vs "ðɛɹˌɑːɹ" inside "There are"). Substring search misses,
  // ~40% of words get t=null, interpolation linearly spreads them, and the
  // highlighter "freezes then jumps."
  //
  // Approach: walk whole-text tokens (whitespace-split, stress-stripped) and
  // input words in parallel. Three cases per input word:
  //   1) ipa expands to multiple tokens (e.g. "2025" → "tuː θaʊzənd twɛnti
  //      faɪv"): consume that many whole-text tokens.
  //   2) whole-text token is much bigger than this word's ipa: fused — share
  //      this token across N consecutive input words, sub-allocating time
  //      proportionally to each word's ipa length.
  //   3) 1:1 — assign and advance.
  const audioDur = wave.length / SAMPLE_RATE;

  // Build normalized phStr (no stress marks, no punctuation) + reverse map
  // back to original code-point indices for charTimes lookup. Punctuation
  // chars are hidden from word alignment — they carry their own model-emitted
  // pause duration but aren't part of any input word's pronunciation.
  const phNormCps = [];
  const phNormToOrig = [];
  for (let i = 0; i < phChars.length; i++) {
    const c = phChars[i];
    if (c === 'ˈ' || c === 'ˌ') continue;
    if (KOKORO_PUNCT_SET.has(c)) continue;
    phNormCps.push(c);
    phNormToOrig.push(i);
  }

  // Tokenize normalized phStr; each token records its start in normalized
  // space (for sub-token offsets) and in original phStr (for charTimes).
  const wholeTokens = [];
  {
    let cur = '';
    let startNorm = 0;
    for (let i = 0; i < phNormCps.length; i++) {
      if (phNormCps[i] === ' ') {
        if (cur) wholeTokens.push({ str: cur, startNorm, startCp: phNormToOrig[startNorm] });
        cur = '';
      } else {
        if (!cur) startNorm = i;
        cur += phNormCps[i];
      }
    }
    if (cur) wholeTokens.push({ str: cur, startNorm, startCp: phNormToOrig[startNorm] });
  }

  const stripStress = (s) => (s || '').replace(/[ˈˌ]/g, '');
  const wordIpaTokens = inputWords.map((_, i) => stripStress(ipaWords[i] || '').split(/\s+/).filter(Boolean));

  const wordTimes = new Array(inputWords.length).fill(null);
  let wti = 0;
  let wi = 0;
  while (wti < wholeTokens.length && wi < inputWords.length) {
    const wt = wholeTokens[wti];
    const wToks = wordIpaTokens[wi];
    const wtTime = charTimes[wt.startCp] ?? 0;

    if (wToks.length === 0) {
      wordTimes[wi] = wtTime;
      wi += 1;
      continue;
    }

    if (wToks.length > 1) {
      // 1 input word → multiple per-word tokens (e.g. "2025"); take the first
      // whole-text token's time and skip ahead by that many whole-text tokens.
      wordTimes[wi] = wtTime;
      wti += wToks.length;
      wi += 1;
      continue;
    }

    const wTok = wToks[0];
    if (wt.str.length >= wTok.length * 1.45) {
      // Fusion: this whole-text token spans this input word + more
      wordTimes[wi] = wtTime;
      let consumedChars = wTok.length;
      let n = 1;
      const nextWtTime = wti + 1 < wholeTokens.length
        ? (charTimes[wholeTokens[wti + 1].startCp] ?? audioDur)
        : audioDur;
      const tokDur = nextWtTime - wtTime;
      while (wi + n < inputWords.length && consumedChars < wt.str.length * 0.85) {
        const nextToks = wordIpaTokens[wi + n];
        if (!nextToks || nextToks.length !== 1) break;
        const len = nextToks[0].length;
        if (consumedChars + len > wt.str.length * 1.15) break;
        // Sub-allocate within wt's duration based on cumulative ipa chars
        const normSubIdx = Math.min(wt.startNorm + consumedChars, phNormToOrig.length - 1);
        const origSubIdx = phNormToOrig[normSubIdx] ?? wt.startCp;
        const fineTime = charTimes[origSubIdx];
        wordTimes[wi + n] = (fineTime != null && fineTime >= wtTime && fineTime <= nextWtTime)
          ? fineTime
          : wtTime + tokDur * (consumedChars / wt.str.length);
        consumedChars += len;
        n += 1;
      }
      wi += n;
      wti += 1;
      continue;
    }

    // 1:1
    wordTimes[wi] = wtTime;
    wi += 1;
    wti += 1;
  }

  // Any remaining input words (whole-text ran out): assign audioDur — caller
  // will see them grouped at the tail rather than scattered.
  while (wi < inputWords.length) {
    wordTimes[wi] = audioDur;
    wi += 1;
  }

  // Enforce monotonic non-decreasing times (defensive against any sub-allocation
  // edge case where charTimes lookup yields a stress-mark slot that's slightly
  // earlier than the previous word's time).
  for (let i = 1; i < wordTimes.length; i++) {
    if (wordTimes[i] < wordTimes[i - 1]) wordTimes[i] = wordTimes[i - 1];
  }

  const words = inputWords.map((w, i) => ({
    w,
    t: Number((wordTimes[i] ?? 0).toFixed(3)),
  }));

  const audioWav = floatToWav(wave, SAMPLE_RATE);
  const durationSec = audioDur;
  return { audioWav, words, sampleRate: SAMPLE_RATE, durationSec };
}
