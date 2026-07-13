/**
 * Ambient declarations for kokoro.js (Kokoro TTS synthesis).
 *
 * The implementation stays JavaScript; this file types its public surface so
 * server.ts (TypeScript) consumes it without `any`.
 */

/** A single word with its start time (seconds) in the synthesized audio. */
export interface WordTiming {
  /** The word text. */
  w: string;
  /** Start time in seconds. */
  t: number;
}

/** Kokoro model native sample rate (Hz). */
export const KOKORO_SAMPLE_RATE: number;

/** Concatenate WAV buffers with a short crossfade between segments. */
export function concatWav(
  wavBuffers: Buffer[],
  sampleRate: number,
  opts?: { fadeMs?: number }
): Buffer;

/** Build a WAV buffer of silence for the given duration. */
export function silenceWav(durationSec: number, sampleRate?: number): Buffer;

/** Transcode a WAV buffer to MP3. */
export function wavToMp3(wavBuf: Buffer, opts?: { xing?: boolean }): Promise<Buffer>;

/**
 * Synthesize speech for a text chunk, returning audio plus per-word timing.
 */
export function synthesize(
  text: string,
  opts?: { voice?: string; speed?: number }
): Promise<{ audioWav: Buffer; words: WordTiming[]; sampleRate: number; durationSec: number }>;
