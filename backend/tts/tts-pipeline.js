// Per-guide TTS pipeline.
//
// Chunks a transcript at sentence boundaries, runs `synthesize()` on each
// chunk, offsets per-word timings by the accumulated audio duration, and
// concatenates the WAV outputs into a single file. Designed to be invoked
// from a background promise — emits progress via the `onProgress` callback
// so the HTTP layer can update Guides.jobs_json without blocking.

import { synthesize, concatWav, silenceWav, wavToMp3, KOKORO_SAMPLE_RATE } from './kokoro.js';

/**
 * Extract a sample range [startSample, endSample) from a 16-bit PCM mono WAV
 * buffer and re-wrap it as a standalone WAV. Used to chop a synthesized chunk
 * into sub-segments at intra-chunk punctuation pauses without re-running the
 * model (which would lose coarticulation).
 */
function sliceWavSamples(wavBuffer, sampleRate, startSample, endSample) {
  const n = Math.max(0, endSample - startSample);
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVE', 8); out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(n * 2, 40);
  wavBuffer.copy(out, 44, 44 + startSample * 2, 44 + endSample * 2);
  return out;
}

/**
 * Scan a segment's word list for punctuation that should trigger a pause,
 * returning `{ atTime, durSec }` entries (only between two real words —
 * no pause after the very last word; the chunk-seam handler covers that).
 *
 * Matches three classes:
 *   - sentence: word ends in `.!?` (optionally followed by a closing quote/paren)
 *   - dash:     word is a standalone em/en dash, or ends in one
 *   - phrase:   word ends in `,;:`
 */
function findPunctuationPauses(words) {
  const pauses = [];
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i].w;
    const nextT = words[i + 1].t;
    if (/[.!?]["')\]]?$/.test(w)) pauses.push({ atTime: nextT, durSec: SENTENCE_PAUSE_SEC });
    else if (/^[—–]+$/.test(w) || /[—–]["')\]]?$/.test(w)) pauses.push({ atTime: nextT, durSec: DASH_PAUSE_SEC });
    else if (/[,;:]["')\]]?$/.test(w)) pauses.push({ atTime: nextT, durSec: PHRASE_PAUSE_SEC });
  }
  return pauses;
}

// Explicit breath padding inserted between chunks. Kokoro now emits real
// pauses for `.`/`!`/`?` natively via the punctuation tokens in its vocab
// (~300-450ms learned from training data), since phonemizeWithPunctuation in
// kokoro.js stopped stripping them. Cross-chunk seams still need a small
// top-up because concatWav's 25ms equal-power crossfade eats the trailing
// silence, and paragraph breaks want extra breath beyond a sentence end.
const PAUSE_MS = { sentence: 150, paragraph: 700, none: 0 };

// Intra-chunk punctuation splice — dialed down since Kokoro now produces
// the bulk of each pause natively (was 300/450/600 when punctuation was
// stripped from input; native pauses now contribute most of the breath).
// Tune up if a particular punctuation still feels rushed after regenerating.
//   comma/colon/semicolon: ~100ms additional on top of ~200ms native
//   em/en dash:            ~150ms additional on top of ~150ms native
//   period/!/?:            ~150ms additional on top of ~400ms native
const PHRASE_PAUSE_SEC = 0.10;
const DASH_PAUSE_SEC = 0.15;
const SENTENCE_PAUSE_SEC = 0.15;

/**
 * Pre-process a transcript so the TTS and frontend tokenizers both see em/en
 * dashes as standalone tokens. Espeak emits ~zero pause for an inline `—`
 * (e.g. "word—word"), and our punctuation-pause detector only sees the END
 * of each word, so inline dashes get no audible break. Splitting them out
 * makes them their own token: Kokoro speaks a brief pause, the detector adds
 * DASH_PAUSE_SEC of silence, and the frontend transcript (which also splits
 * on whitespace) lines up word-for-word with the timing stream.
 *
 * Also converts `--` and `---` to `—` so prose using ASCII dashes gets the
 * same treatment.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeForTts(text) {
  // Lookbehind/lookahead so consecutive dashes (e.g. "a—b—c") all match — a
  // capturing variant would consume the boundary char and skip every other one.
  return String(text || '')
    .replace(/-{2,}/g, '—')                  // -- / --- → em dash
    .replace(/(?<=\S)([—–])(?=\S)/g, ' $1 ') // inline dash → standalone
    .replace(/(?<=\S)([—–])(?=\s)/g, ' $1')  // trailing dash on word → standalone
    .replace(/(?<=\s)([—–])(?=\S)/g, '$1 '); // leading dash on word → standalone
}

/**
 * Synthesize one chunk, and if Kokoro complains about input length
 * ("invalid expand shape"), recursively split the chunk in half on the
 * nearest sentence boundary and retry each half. Returns an array of
 * { audioWav, words, durationSec } segments in order.
 *
 * @param {string} text
 * @param {Object} opts - Passed through to synthesize()
 * @returns {Promise<Array<{audioWav: Buffer, words: Array<{w:string,t:number}>, durationSec: number}>>}
 */
async function synthesizeWithFallback(text, opts) {
  try {
    const r = await synthesize(text, opts);
    return [r];
  } catch (err) {
    const msg = String(err?.message || '');
    const recoverable = /expand shape|expand node|out of range|token.*exceed/i.test(msg);
    if (!recoverable) throw err;
    // Split in half at the nearest sentence boundary (or char midpoint if none).
    const sentences = text.split(/(?<=[.!?])\s+/);
    if (sentences.length < 2) {
      const mid = Math.floor(text.length / 2);
      const left = text.slice(0, mid);
      const right = text.slice(mid);
      const a = await synthesizeWithFallback(left, opts);
      const b = await synthesizeWithFallback(right, opts);
      return [...a, ...b];
    }
    const half = Math.floor(sentences.length / 2);
    const left = sentences.slice(0, half).join(' ');
    const right = sentences.slice(half).join(' ');
    const a = await synthesizeWithFallback(left, opts);
    const b = await synthesizeWithFallback(right, opts);
    return [...a, ...b];
  }
}

// Kokoro hard-caps input at 510 tokens (including BOS/EOS). For English the
// phonemizer is roughly 1:1 (sometimes 1:1.2) on char-to-phoneme, so ~450
// chars lands at ~400-500 tokens — under the cap with headroom while giving
// the model enough text per chunk (3-5 sentences) to maintain prosody and
// intonation across sentence boundaries. Smaller chunks → flat, choppy
// pronunciation; larger chunks → "invalid expand shape" ONNX error at
// /encoder/bert/Expand.
const MAX_CHUNK_CHARS = 380;

/**
 * Split text into chunks of at most `maxChars` characters, breaking at
 * paragraph boundaries first (two-or-more newlines), then at sentence
 * boundaries (period/!/? followed by whitespace). Falls back to a hard
 * split if any single sentence is longer than `maxChars`.
 *
 * Returns chunks tagged with `breakAfter` so the pipeline can inject the
 * right amount of silence between them — `'paragraph'` for the last chunk
 * of a paragraph, `'sentence'` for mid-paragraph chunk seams, `'none'` for
 * the very last chunk.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {Array<{text: string, breakAfter: 'paragraph'|'sentence'|'none'}>}
 */
function chunkBySentence(text, maxChars = MAX_CHUNK_CHARS) {
  const paragraphs = text.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
  const chunks = [];

  paragraphs.forEach((para, pIdx) => {
    const sentences = para
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean);

    const paraChunks = [];
    let buf = '';
    for (const s of sentences) {
      if (s.length > maxChars) {
        if (buf) { paraChunks.push(buf); buf = ''; }
        for (let i = 0; i < s.length; i += maxChars) {
          paraChunks.push(s.slice(i, i + maxChars));
        }
        continue;
      }
      if (buf.length + s.length + 1 > maxChars) {
        paraChunks.push(buf);
        buf = s;
      } else {
        buf = buf ? `${buf} ${s}` : s;
      }
    }
    if (buf) paraChunks.push(buf);

    paraChunks.forEach((t, i) => {
      const isLastInPara = i === paraChunks.length - 1;
      const isLastPara = pIdx === paragraphs.length - 1;
      const breakAfter = isLastInPara
        ? (isLastPara ? 'none' : 'paragraph')
        : 'sentence';
      chunks.push({ text: t, breakAfter });
    });
  });

  return chunks;
}

/**
 * Run Kokoro TTS over an entire transcript, chunk-by-chunk, returning a single
 * WAV buffer plus the merged per-word timing stream.
 *
 * @param {Object} args
 * @param {string} args.transcript - Full essay text
 * @param {string} [args.voice='af_heart'] - Kokoro voice id
 * @param {number} [args.speed=1] - Speech rate
 * @param {function({chunksDone: number, chunksTotal: number}): void} [args.onProgress]
 * @param {function(Buffer, {index: number, chunksDone: number, chunksTotal: number}): (void | Promise<void>)} [args.onChunk]
 *   Called once per source chunk with that chunk's audio as a standalone MP3
 *   (Xing header suppressed) as soon as it renders — used to stream playback
 *   before the full guide finishes. Concatenating these in order yields a
 *   playable stream. The canonical `audioMp3` return value is still a single
 *   sample-accurate encode; onChunk is a delivery optimization, not the source
 *   of truth. Awaited, so a slow writer backpressures synthesis.
 * @returns {Promise<{audioMp3: Buffer, words: Array<{w: string, t: number}>, totalDuration: number, sampleRate: number, transcript: string}>}
 *          `audioMp3` is 64kbps mono MP3 — the pipeline renders WAV internally
 *          for sample-accurate splicing, then transcodes once at the very end.
 *          `transcript` is the normalized version actually fed to the TTS;
 *          the caller should persist it so the displayed transcript stays
 *          tokenized the same way as the timing stream.
 */
export async function synthesizeGuide({ transcript, voice = 'af_heart', speed = 1, onProgress, onChunk }) {
  if (!transcript || transcript.length < 50) throw new Error('Transcript too short');

  // Normalize once up front. The caller should persist this back so the
  // displayed transcript and the timing stream stay tokenized the same way.
  const normalized = normalizeForTts(transcript);

  const chunks = chunkBySentence(normalized);
  let chunksTotal = chunks.length;
  onProgress?.({ chunksDone: 0, chunksTotal });

  const wavs = [];
  const words = [];
  let elapsed = 0;
  let done = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Track which wavs this source chunk contributes so onChunk can emit just
    // this chunk's audio as a standalone MP3 for streaming.
    const chunkWavStart = wavs.length;
    const result = await synthesizeWithFallback(chunk.text, { voice, speed });
    for (let segIdx = 0; segIdx < result.length; segIdx++) {
      const segment = result[segIdx];
      const sr = segment.sampleRate || KOKORO_SAMPLE_RATE;
      const totalSamples = Math.floor(segment.durationSec * sr);
      const pauses = findPunctuationPauses(segment.words);

      if (!pauses.length) {
        for (const w of segment.words) {
          words.push({ w: w.w, t: Number((w.t + elapsed).toFixed(3)) });
        }
        wavs.push(segment.audioWav);
        elapsed += segment.durationSec;
        continue;
      }

      // Split the rendered audio at each punctuation boundary and interleave
      // silence. Word timings shift by the cumulative inserted silence so the
      // highlighter stays aligned with the audio post-splice.
      const splitSamples = pauses.map(p =>
        Math.max(0, Math.min(totalSamples, Math.round(p.atTime * sr)))
      );
      const boundaries = [0, ...splitSamples, totalSamples];
      let wIdx = 0;
      for (let bi = 0; bi < boundaries.length - 1; bi++) {
        const startS = boundaries[bi];
        const endS = boundaries[bi + 1];
        if (endS <= startS) continue;
        const subStartT = startS / sr;
        const subEndT = endS / sr;
        const subDur = subEndT - subStartT;
        while (wIdx < segment.words.length && segment.words[wIdx].t < subEndT) {
          const localT = segment.words[wIdx].t - subStartT;
          words.push({ w: segment.words[wIdx].w, t: Number((elapsed + localT).toFixed(3)) });
          wIdx++;
        }
        wavs.push(sliceWavSamples(segment.audioWav, sr, startS, endS));
        elapsed += subDur;
        if (bi < pauses.length) {
          const pauseSec = pauses[bi].durSec;
          wavs.push(silenceWav(pauseSec, sr));
          elapsed += pauseSec;
        }
      }
      while (wIdx < segment.words.length) {
        const localT = segment.words[wIdx].t - (totalSamples / sr);
        words.push({ w: segment.words[wIdx].w, t: Number((elapsed + localT).toFixed(3)) });
        wIdx++;
      }

      // Inter-segment seam pause. Only fires when synthesizeWithFallback had to
      // split a chunk (recoverable-error retry path) — those splits happen on
      // sentence boundaries, so the LAST word of every non-final segment ends
      // in `.!?` and deserves a sentence-grade breath. findPunctuationPauses
      // intentionally skips the last word, so we handle it here.
      if (segIdx < result.length - 1) {
        wavs.push(silenceWav(SENTENCE_PAUSE_SEC, sr));
        elapsed += SENTENCE_PAUSE_SEC;
      }
    }
    const pauseMs = PAUSE_MS[chunk.breakAfter] ?? 0;
    if (pauseMs > 0) {
      const sec = pauseMs / 1000;
      wavs.push(silenceWav(sec, KOKORO_SAMPLE_RATE));
      elapsed += sec;
    }
    done += 1;
    onProgress?.({ chunksDone: done, chunksTotal });

    // Emit this chunk's audio as a standalone MP3 for streaming. Best-effort:
    // a streaming failure must not abort the canonical render.
    if (onChunk) {
      const chunkWavs = wavs.slice(chunkWavStart);
      if (chunkWavs.length) {
        try {
          const chunkWav = concatWav(chunkWavs, KOKORO_SAMPLE_RATE, { fadeMs: 0 });
          const chunkMp3 = await wavToMp3(chunkWav, { xing: false });
          // Pass the cumulative word timings + the normalized transcript so the
          // caller can stream captions for the portion rendered so far.
          await onChunk(chunkMp3, { index: i, chunksDone: done, chunksTotal, words: words.slice(), transcript: normalized });
        } catch (err) {
          console.error(`[tts] onChunk failed for chunk ${i}:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  // fadeMs:0 — every seam in this pipeline is wav→silence→wav, so the
  // crossfade is smoothing silence and only steals nominal time. Each
  // crossfade lost ~25ms from the output, compounding to ~5s drift over a
  // long guide and dragging the highlighter behind the audio. Butt-joining
  // is safe here because all wav-to-wav transitions go through silence.
  const wav = concatWav(wavs, KOKORO_SAMPLE_RATE, { fadeMs: 0 });
  // Transcode to MP3 at the very end. The pipeline needed lossless WAV
  // internally for sample-accurate splicing/silence insertion; once that's
  // done, MP3@64k mono is ~6× smaller (a 1hr guide goes from 170MB → 28MB)
  // and stays under GitHub's 100MB per-file ceiling. Encoder padding is
  // ~10-25ms — well inside the 270ms HIGHLIGHT_LEAD — so timings stay valid.
  const audioMp3 = await wavToMp3(wav);
  return {
    audioMp3,
    words,
    totalDuration: Number(elapsed.toFixed(3)),
    sampleRate: KOKORO_SAMPLE_RATE,
    transcript: normalized,
  };
}
