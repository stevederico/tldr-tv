/**
 * Transcript + timing helpers for the PiP player — a plain-JS port of the
 * pure functions in src/utils/playerUtils.ts (the extension has no build step,
 * so it can't import the TS source). Keep the two in sync when either changes.
 */

const TOKEN_STRIP_RX = /[^\w']/g;
const QUOTE_STRIP_RX = /[^\w\s']/g;
const WHITESPACE_RX = /\s+/;
const WHITESPACE_RX_G = /\s+/g;
const HARD_BREAK_RX = /[.!?]/;
const SOFT_BREAK_RX = /[,;:]/;
const LINE_BREAK_RX = /\r?\n/;
const SOURCE_PREFIX_RX = /^Source:/i;
const PARA_SPLIT_RX = /\n\s*\n+/;
const SENTENCE_TERMINAL_RX = /[.!?][)"'""']?$/;
const NUMERIC_MARKER_RX = /^\d+\.?$/;

/**
 * @typedef {{ text: string, index: number }} TranscriptWord
 * @typedef {{ words: TranscriptWord[] }} TranscriptParagraph
 * @typedef {{ w: string, t: number }} TimingWord
 * @typedef {{ word: number, time: number }} Anchor
 * @typedef {{ start: number, end: number, text: string }} CaptionChunk
 */

/**
 * Lowercase a token and strip non-word characters for fuzzy matching.
 *
 * @param {string} s - Raw token text.
 * @returns {string} Normalized token.
 */
export function normalizeToken(s) {
  return String(s).toLowerCase().replace(TOKEN_STRIP_RX, '');
}

/**
 * Parse raw transcript text into paragraphs of globally-indexed words.
 *
 * @param {string} text - Raw transcript text.
 * @returns {TranscriptParagraph[]} Parsed paragraphs.
 */
export function parseTranscript(text) {
  const lines = text.split(LINE_BREAK_RX);
  let start = 0;
  if (lines[0]?.startsWith('#')) {
    start = lines.findIndex((l, i) => i > 0 && l.trim() === '');
    start = start === -1 ? 0 : start + 1;
  }
  while (start < lines.length && SOURCE_PREFIX_RX.test(lines[start])) start++;
  while (start < lines.length && lines[start].trim() === '') start++;
  const body = lines.slice(start).join('\n');
  const chunks = body.split(PARA_SPLIT_RX).map((p) => p.replace(WHITESPACE_RX_G, ' ').trim()).filter(Boolean);
  const paras = [];
  let current = '';
  for (const chunk of chunks) {
    const endsTerminal = SENTENCE_TERMINAL_RX.test(chunk);
    const wordCount = chunk.split(WHITESPACE_RX).length;
    if (NUMERIC_MARKER_RX.test(chunk) || (wordCount <= 5 && !endsTerminal)) {
      if (current) {
        paras.push(current);
        current = '';
      }
      paras.push(chunk);
      continue;
    }
    current = current ? current + ' ' + chunk : chunk;
    if (endsTerminal) {
      paras.push(current);
      current = '';
    }
  }
  if (current) paras.push(current);
  let wordCounter = 0;
  return paras.map((p) => ({
    words: p.split(' ').map((w) => ({ text: w, index: wordCounter++ })),
  }));
}

/**
 * Align transcript words to backend timing words → per-word start times.
 *
 * @param {TranscriptParagraph[] | null} transcriptParas - Parsed paragraphs.
 * @param {TimingWord[] | null} timingWords - Raw timing entries.
 * @returns {number[] | null} Per-word start times, or null.
 */
export function alignTimings(transcriptParas, timingWords) {
  if (!transcriptParas || !timingWords?.length) return null;
  const flat = transcriptParas.flatMap((p) => p.words);
  const times = new Array(flat.length).fill(null);
  let ti = 0;
  for (let i = 0; i < flat.length && ti < timingWords.length; i++) {
    const tw = normalizeToken(flat[i].text);
    if (!tw) continue;
    for (let k = 0; k < 5 && ti + k < timingWords.length; k++) {
      if (normalizeToken(timingWords[ti + k].w) === tw) {
        times[i] = timingWords[ti + k].t;
        ti += k + 1;
        break;
      }
    }
  }
  let last = 0;
  const filled = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t == null) {
      filled.push(last);
    } else {
      last = t;
      filled.push(t);
    }
  }
  return filled;
}

/**
 * Binary-search the last word whose start time is <= `t`.
 *
 * @param {number[] | null} wordStartTimes - Monotonic per-word start times.
 * @param {number} t - Time in seconds.
 * @returns {number} Word index, or -1 when empty.
 */
export function wordIndexFromTimes(wordStartTimes, t) {
  if (!wordStartTimes?.length) return -1;
  let lo = 0;
  let hi = wordStartTimes.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (wordStartTimes[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Find the word index where a chapter quote begins in the flat word list.
 *
 * @param {string[]} flatWords - Flat transcript words.
 * @param {string | undefined} quote - Chapter quote.
 * @param {number} [hintIdx] - Start index for ordered scanning.
 * @returns {number} Start word index, or -1.
 */
export function findQuoteStartWord(flatWords, quote, hintIdx = 0) {
  const q = (quote || '')
    .toLowerCase()
    .replace(QUOTE_STRIP_RX, ' ')
    .split(WHITESPACE_RX)
    .filter(Boolean)
    .slice(0, 6);
  if (q.length < 2) return -1;
  for (let i = hintIdx; i <= flatWords.length - q.length; i++) {
    let match = true;
    for (let j = 0; j < q.length; j++) {
      if (normalizeToken(flatWords[i + j]) !== q[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Build word/time anchors from chapter quotes (fallback when no timing words).
 *
 * @param {TranscriptParagraph[] | null} transcriptParas - Parsed paragraphs.
 * @param {Array<{ time?: number, quote?: string }> | undefined} chapters - Chapters.
 * @param {number} duration - Total audio duration (seconds).
 * @returns {Anchor[] | null} Sorted anchors, or null.
 */
export function buildAnchors(transcriptParas, chapters, duration) {
  if (!transcriptParas || !chapters?.length || !duration) return null;
  const flat = transcriptParas.flatMap((p) => p.words.map((w) => w.text));
  const total = flat.length;

  const found = [];
  let hint = 0;
  chapters.forEach((ch) => {
    if (ch.time == null) return;
    const wIdx = findQuoteStartWord(flat, ch.quote, hint);
    if (wIdx < 0) return;
    found.push({ word: wIdx, time: ch.time });
    hint = wIdx + 1;
  });

  let pace = 0;
  if (found.length >= 2) {
    const paces = [];
    for (let i = 1; i < found.length; i++) {
      const dw = found[i].word - found[i - 1].word;
      const dt = found[i].time - found[i - 1].time;
      if (dw > 0 && dt > 0) paces.push(dw / dt);
    }
    if (paces.length) {
      paces.sort((a, b) => a - b);
      pace = paces[Math.floor(paces.length / 2)];
    }
  }

  if (found.length && found[0].word > 0 && found[0].time === 0 && pace > 0) {
    found[0] = { word: found[0].word, time: found[0].word / pace };
  }

  const anchors = [...found].sort((a, b) => a.time - b.time);
  if (!anchors.length || anchors[0].time > 0 || anchors[0].word > 0) {
    anchors.unshift({ word: 0, time: 0 });
  }
  if (anchors.length && anchors[anchors.length - 1].word < total) {
    anchors.push({ word: total, time: duration });
  }
  return anchors;
}

/**
 * Interpolate the active word index at time `t` from word/time anchors.
 *
 * @param {Anchor[] | null} anchors - Sorted anchors.
 * @param {number} t - Time in seconds.
 * @returns {number} Word index.
 */
export function wordIndexAtTime(anchors, t) {
  if (!anchors || anchors.length < 2) return 0;
  let i = 0;
  while (i < anchors.length - 1 && anchors[i + 1].time <= t) i++;
  const a = anchors[i];
  const b = anchors[i + 1] || a;
  if (!b || b.time <= a.time) return a.word;
  const frac = (t - a.time) / (b.time - a.time);
  return Math.round(a.word + frac * (b.word - a.word));
}

/**
 * Group transcript words into readable caption chunks.
 *
 * @param {TranscriptParagraph[] | null} transcriptParas - Parsed paragraphs.
 * @returns {CaptionChunk[] | null} Caption chunks, or null.
 */
export function buildCaptionChunks(transcriptParas) {
  if (!transcriptParas) return null;
  const flat = transcriptParas.flatMap((p) => p.words);
  const chunks = [];
  const MAX = 12;
  const SOFT = 7;
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    chunks.push({
      start: buf[0].index,
      end: buf[buf.length - 1].index,
      text: buf.map((w) => w.text).join(' '),
    });
    buf = [];
  };
  for (const w of flat) {
    buf.push(w);
    const last = w.text[w.text.length - 1];
    const hardBreak = HARD_BREAK_RX.test(last);
    const softBreak = SOFT_BREAK_RX.test(last);
    if (hardBreak || buf.length >= MAX || (softBreak && buf.length >= SOFT)) flush();
  }
  flush();
  return chunks;
}

/**
 * Binary-search the caption chunk containing word index `wIdx`.
 *
 * @param {CaptionChunk[] | null} chunks - Caption chunks.
 * @param {number} wIdx - Word index.
 * @returns {number} Chunk index, or -1.
 */
export function chunkIndexAtWord(chunks, wIdx) {
  if (!chunks?.length) return -1;
  let lo = 0;
  let hi = chunks.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid].start <= wIdx) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
