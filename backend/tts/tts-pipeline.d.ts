/**
 * Ambient declarations for tts-pipeline.js (full guide synthesis pipeline).
 *
 * The implementation stays JavaScript; this file types its public surface.
 */
import type { WordTiming } from './kokoro.d.ts';

/** Progress event emitted by synthesizeGuide as chunks complete. */
export interface TtsProgress {
  /** Chunks synthesized so far. */
  chunksDone: number;
  /** Total chunks to synthesize. */
  chunksTotal: number;
}

/** Metadata for a single streamed chunk MP3. */
export interface TtsChunkMeta {
  /** Zero-based source chunk index. */
  index: number;
  /** Chunks synthesized so far (== index + 1). */
  chunksDone: number;
  /** Total chunks to synthesize. */
  chunksTotal: number;
  /** Cumulative per-word timings for everything rendered so far. */
  words: WordTiming[];
  /** Normalized transcript fed to the TTS (stable across chunks). */
  transcript: string;
}

/** Normalize text for TTS (expand abbreviations, strip markup, etc.). */
export function normalizeForTts(text: string): string;

/**
 * Synthesize a full guide: chunk the transcript, synthesize each chunk, and
 * concatenate into a single MP3 with aligned word timings.
 */
export function synthesizeGuide(args: {
  transcript: string;
  voice?: string;
  speed?: number;
  onProgress?: (progress: TtsProgress) => void;
  onChunk?: (pcm: Buffer, meta: TtsChunkMeta) => void | Promise<void>;
}): Promise<{
  audioMp3: Buffer;
  words: WordTiming[];
  totalDuration: number;
  sampleRate: number;
  transcript: string;
}>;
