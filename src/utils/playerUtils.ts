// Pure utility functions extracted from PlayerView.tsx

/** A single word in a parsed transcript paragraph. */
export interface TranscriptWord {
  /** The word text (no surrounding whitespace). */
  text: string;
  /** Zero-based global word index across the whole transcript. */
  index: number;
}

/** A parsed transcript paragraph — a run of words. */
export interface TranscriptParagraph {
  words: TranscriptWord[];
}

/** A raw timing entry from the backend: word `w` spoken at time `t` (seconds). */
export interface TimingWord {
  /** Word text as recognized by the TTS/aligner. */
  w: string;
  /** Start time in seconds. */
  t: number;
}

/** A chapter within a guide. */
export interface Chapter {
  /** Start time in seconds. */
  time?: number;
  /** Chapter title. */
  title?: string;
  /** Short quote used to locate the chapter start in the transcript. */
  quote?: string;
  /** Optional caption text. */
  caption?: string;
  /** Generated illustrative image variants. */
  image?: { generated?: string } | null;
  /** Real (photo) image URL. */
  realImage?: string | null;
}

/** Status of a background pipeline/enrichment job on a guide. */
export interface GuideJob {
  /** Current job status. */
  status?: 'running' | 'done' | 'failed';
  /** Error message when status is 'failed'. */
  error?: string;
  /** Total chunks for progress display (TTS/image jobs). */
  chunksTotal?: number;
  /** Completed chunks so far. */
  chunksDone?: number;
}

/**
 * A guide — the core content unit (article/essay turned into an audio "book").
 * Fields are largely optional because they're filled in progressively by the
 * backend enrichment pipeline.
 */
export interface Guide {
  /** URL slug / id. */
  slug: string;
  /** Display title. */
  title: string;
  /** Author name. */
  author?: string;
  /** Publish/source date string. */
  date?: string;
  /** Alternate published date field. */
  publishedAt?: string;
  /** Full transcript text. */
  transcript?: string;
  /** Short AI-generated summary. */
  summary?: string;
  /** Audio file path. */
  audio?: string;
  /** Audio duration in seconds. */
  duration?: number;
  /** Cover thumbnail path. */
  thumbnail?: string;
  /** Source URL the guide was created from. */
  sourceUrl?: string;
  /** Word-level timing data. */
  timing?: TimingWord[] | { words?: TimingWord[] } | null;
  /** Calibration offset (seconds) applied to word timings. */
  timingOffset?: number;
  /** Chapter outline. */
  chapters?: Chapter[];
  /** Default view mode for the library. */
  defaultViewMode?: string;
  /** Visibility, e.g. 'public'. */
  visibility?: string;
  /** Last-updated timestamp (used for audio cache-busting). */
  updatedAt?: string | number;
  /** Background job state keyed by job/run name (e.g. 'pipeline', 'tts'). */
  jobs?: Record<string, GuideJob | undefined>;
}

/** A word/time anchor used to interpolate playback position from word index. */
export interface Anchor {
  /** Global word index. */
  word: number;
  /** Time in seconds. */
  time: number;
}

/** A caption chunk spanning a contiguous range of words. */
export interface CaptionChunk {
  /** First word index in the chunk. */
  start: number;
  /** Last word index in the chunk. */
  end: number;
  /** Joined chunk text. */
  text: string;
}

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
const NOTE_TIMESTAMP_RX = /\[(\d+):(\d{2})\]/g;

/**
 * Lowercase a token and strip non-word characters for fuzzy text matching.
 *
 * @param s - Raw token text.
 * @returns Normalized token.
 */
export function normalizeToken(s: string): string {
  return s.toLowerCase().replace(TOKEN_STRIP_RX, '');
}

/**
 * Align parsed transcript words to backend timing words, producing a per-word
 * start-time array. Fills gaps by carrying the previous known time forward.
 *
 * @param transcriptParas - Parsed transcript paragraphs.
 * @param timingWords - Raw timing entries from the backend.
 * @returns Start time (seconds) per transcript word, or null if unavailable.
 */
export function alignTimings(
  transcriptParas: TranscriptParagraph[] | null,
  timingWords: TimingWord[] | null
): number[] | null {
  if (!transcriptParas || !timingWords?.length) return null;
  const flat = transcriptParas.flatMap(p => p.words);
  const times: (number | null)[] = new Array(flat.length).fill(null);
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
  const filled: number[] = [];
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
 * @param wordStartTimes - Monotonic per-word start times.
 * @param t - Time in seconds.
 * @returns Word index, or -1 when there are no times.
 */
export function wordIndexFromTimes(wordStartTimes: number[] | null, t: number): number {
  if (!wordStartTimes?.length) return -1;
  let lo = 0, hi = wordStartTimes.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (wordStartTimes[mid] <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/**
 * Find the word index where a chapter quote begins in the flat word list.
 *
 * @param flatWords - Flat list of transcript words (text only).
 * @param quote - Chapter quote to locate.
 * @param hintIdx - Index to start searching from (for ordered scanning).
 * @returns Start word index, or -1 if not found.
 */
export function findQuoteStartWord(flatWords: string[], quote: string | undefined, hintIdx = 0): number {
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
      if (normalizeToken(flatWords[i + j]) !== q[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Build word/time anchors by locating each chapter quote in the transcript and
 * estimating reading pace. Always brackets the transcript with (0,0) and
 * (totalWords, duration) anchors so interpolation covers the full range.
 *
 * @param transcriptParas - Parsed transcript paragraphs.
 * @param chapters - Guide chapters (with quotes + times).
 * @param duration - Total audio duration in seconds.
 * @returns Sorted anchors, or null if inputs are insufficient.
 */
export function buildAnchors(
  transcriptParas: TranscriptParagraph[] | null,
  chapters: Chapter[] | undefined,
  duration: number
): Anchor[] | null {
  if (!transcriptParas || !chapters?.length || !duration) return null;
  const flat = transcriptParas.flatMap(p => p.words.map(w => w.text));
  const total = flat.length;

  const found: Anchor[] = [];
  let hint = 0;
  chapters.forEach(ch => {
    if (ch.time == null) return;
    const wIdx = findQuoteStartWord(flat, ch.quote, hint);
    if (wIdx < 0) return;
    found.push({ word: wIdx, time: ch.time });
    hint = wIdx + 1;
  });

  let pace = 0;
  if (found.length >= 2) {
    const paces: number[] = [];
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
 * @param anchors - Sorted word/time anchors.
 * @param t - Time in seconds.
 * @returns Word index.
 */
export function wordIndexAtTime(anchors: Anchor[] | null, t: number): number {
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
 * Interpolate the playback time (seconds) at a given word index from anchors.
 *
 * @param anchors - Sorted word/time anchors.
 * @param wIdx - Word index.
 * @returns Time in seconds.
 */
export function timeAtWordIndex(anchors: Anchor[] | null, wIdx: number): number {
  if (!anchors || anchors.length < 2) return 0;
  let i = 0;
  while (i < anchors.length - 1 && anchors[i + 1].word <= wIdx) i++;
  const a = anchors[i];
  const b = anchors[i + 1] || a;
  if (!b || b.word <= a.word) return a.time;
  const frac = (wIdx - a.word) / (b.word - a.word);
  return a.time + frac * (b.time - a.time);
}

/**
 * Group transcript words into caption chunks, breaking on sentence punctuation
 * or length limits so captions stay readable.
 *
 * @param transcriptParas - Parsed transcript paragraphs.
 * @returns Caption chunks, or null when no transcript.
 */
export function buildCaptionChunks(transcriptParas: TranscriptParagraph[] | null): CaptionChunk[] | null {
  if (!transcriptParas) return null;
  const flat = transcriptParas.flatMap(p => p.words);
  const chunks: CaptionChunk[] = [];
  const MAX = 12;
  const SOFT = 7;
  let buf: TranscriptWord[] = [];
  const flush = () => {
    if (!buf.length) return;
    chunks.push({
      start: buf[0].index,
      end: buf[buf.length - 1].index,
      text: buf.map(w => w.text).join(' ')
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
 * @param chunks - Caption chunks.
 * @param wIdx - Word index.
 * @returns Chunk index, or -1 when no chunks.
 */
export function chunkIndexAtWord(chunks: CaptionChunk[] | null, wIdx: number): number {
  if (!chunks?.length) return -1;
  let lo = 0, hi = chunks.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid].start <= wIdx) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/**
 * Parse raw transcript text into paragraphs of indexed words, merging
 * hard-wrapped fragments and keeping standalone markers/headings separate.
 *
 * @param text - Raw transcript text.
 * @returns Parsed paragraphs with globally-indexed words.
 */
export function parseTranscript(text: string): TranscriptParagraph[] {
  const lines = text.split(LINE_BREAK_RX);
  let start = 0;
  if (lines[0]?.startsWith('#')) {
    start = lines.findIndex((l, i) => i > 0 && l.trim() === '');
    start = start === -1 ? 0 : start + 1;
  }
  while (start < lines.length && SOURCE_PREFIX_RX.test(lines[start])) start++;
  while (start < lines.length && lines[start].trim() === '') start++;
  const body = lines.slice(start).join('\n');
  const chunks = body.split(PARA_SPLIT_RX).map(p => p.replace(WHITESPACE_RX_G, ' ').trim()).filter(Boolean);
  // Many sources hard-wrap every visual line with a blank line between, losing real
  // paragraph boundaries. Merge fragments that don't end on sentence-terminal
  // punctuation with the next chunk; standalone numeric markers (footnotes, section
  // numbers) stay as their own paragraph.
  const paras: string[] = [];
  let current = '';
  for (const chunk of chunks) {
    const endsTerminal = SENTENCE_TERMINAL_RX.test(chunk);
    const wordCount = chunk.split(WHITESPACE_RX).length;
    // Standalone: numeric markers, or short heading-like chunks (≤5 words) that
    // don't end with sentence-terminal punctuation — titles, dates, section labels.
    if (NUMERIC_MARKER_RX.test(chunk) || (wordCount <= 5 && !endsTerminal)) {
      if (current) { paras.push(current); current = ''; }
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
  return paras.map(p => {
    const words = p.split(' ').map(w => ({ text: w, index: wordCounter++ }));
    return { words };
  });
}

/**
 * Format seconds as `m:ss`.
 *
 * @param sec - Time in seconds.
 * @returns `m:ss` string (`00:00` for missing/NaN input).
 */
export function fmt(sec: number | undefined | null): string {
  if (!sec || isNaN(sec)) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

/**
 * Extracts all [m:ss] timestamps from the notes text and returns sorted unique seconds.
 * Matches the format written by the note popup.
 *
 * @param notesText - Notes textarea contents.
 * @returns Sorted unique timestamps in seconds.
 */
export function parseNoteTimestamps(notesText: string | undefined | null): number[] {
  if (!notesText) return [];
  const times = new Set<number>();
  for (const match of notesText.matchAll(NOTE_TIMESTAMP_RX)) {
    const min = parseInt(match[1], 10);
    const sec = parseInt(match[2], 10);
    times.add(min * 60 + sec);
  }
  return Array.from(times).sort((a, b) => a - b);
}

/**
 * Resolve a stored asset path (`../images/x` -> `/images/x`) for browser use.
 *
 * @param p - Stored asset path.
 * @returns Browser-resolvable URL.
 */
export function resolveAsset(p: string | undefined | null): string {
  if (!p) return '';
  return p.startsWith('../') ? '/' + p.slice(3) : p;
}

/**
 * Find the index of the active chapter at time `t` (last chapter started <= t).
 *
 * @param chapters - Guide chapters.
 * @param t - Time in seconds.
 * @returns Active chapter index.
 */
export function findChapterIndex(chapters: Chapter[], t: number): number {
  let idx = 0;
  for (let i = 0; i < chapters.length; i++) {
    if ((chapters[i].time ?? 0) <= t) idx = i;
    else break;
  }
  return idx;
}
