/**
 * The pluggable pipeline.
 *
 * These three shapes are fixed by the brief and reproduced here exactly as given.
 * Every provider — real or fake — implements them, and the loop is written against
 * them and nothing else. That is the whole of criterion 7: swapping an
 * implementation must require no change to the loop.
 *
 *   interface STT { transcribeStream(audio: AudioStream): AsyncIterable<{ text: string; final: boolean }>; }
 *   interface LLM { respond(messages: Message[]): AsyncIterable<{ text: string }>; }
 *   interface TTS { synthesizeStream(text: string): AsyncIterable<AudioChunk>; }
 *
 * Do not widen them. If a provider needs configuration, take it in the constructor.
 */

import type { AudioChunk, AudioStream } from './audio.js';
import type { Message } from './messages.js';

/** A transcription result. `final: false` is a partial, revisable as more audio arrives. */
export type Transcript = { text: string; final: boolean };

/** A piece of a streamed model reply. */
export type ReplyDelta = { text: string };

export interface STT {
  transcribeStream(audio: AudioStream): AsyncIterable<{ text: string; final: boolean }>;
}

export interface LLM {
  respond(messages: Message[]): AsyncIterable<{ text: string }>;
}

export interface TTS {
  synthesizeStream(text: string): AsyncIterable<AudioChunk>;
}

/** The three stages, assembled. What the loop is handed. */
export interface Pipeline {
  readonly stt: STT;
  readonly llm: LLM;
  readonly tts: TTS;
}
