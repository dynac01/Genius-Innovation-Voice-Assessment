/**
 * Audio primitives shared by both directions of the loop.
 *
 * One chunk type serves capture and playback alike, so `AudioStream` (mic in) and
 * the TTS output stream are the same shape. That symmetry is what lets a fake sit
 * on either side without adapters.
 */

/** A half-open character range `[start, end)` of some synthesis input. */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * A frame of mono PCM.
 *
 * `span` is the piece that makes criterion 2 tractable. Resuming an interrupted
 * reply means continuing from the last character the user actually *heard*, not
 * from wherever the LLM stopped generating — so audio has to be correlatable back
 * to the text that produced it. Providers that report timings can fill this in
 * precisely; for those that cannot, the loop apportions it across the chunk it
 * submitted. Absent on captured audio, which corresponds to no text.
 */
export interface AudioChunk {
  readonly pcm: Int16Array;
  readonly sampleRate: number;
  readonly span?: TextSpan;
}

/** Microphone audio, as consumed by {@link STT.transcribeStream}. */
export type AudioStream = AsyncIterable<AudioChunk>;

/** How long this frame takes to play, in milliseconds. */
export function chunkDurationMs(chunk: AudioChunk): number {
  return (chunk.pcm.length / chunk.sampleRate) * 1000;
}

/** Total playtime of a sequence of frames, in milliseconds. */
export function totalDurationMs(chunks: readonly AudioChunk[]): number {
  let ms = 0;
  for (const chunk of chunks) ms += chunkDurationMs(chunk);
  return ms;
}

/** Sample count for a given duration at a given rate. */
export function samplesForMs(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate);
}

/** A frame of digital silence. Real enough to flow through the whole playback path. */
export function silentFrame(ms: number, sampleRate: number): Int16Array {
  return new Int16Array(samplesForMs(ms, sampleRate));
}
