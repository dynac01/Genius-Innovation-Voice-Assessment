import type { AudioFrame, ClientEvent, ServerEvent } from '@voice/core';
import { decodeAudioFrame, encodeAudioFrame, isServerEvent } from '@voice/core';

/**
 * The browser end of the socket.
 *
 * A single duplex connection carries both directions: JSON text frames for control,
 * binary frames for audio. Nothing here interprets what it moves — the encoding
 * lives in @voice/core and is unit tested there.
 */
export interface VoiceSocketHandlers {
  onOpen?: () => void;
  onEvent?: (event: ServerEvent) => void;
  onAudio?: (frame: AudioFrame) => void;
  onClose?: (info: { clean: boolean; reason: string }) => void;
  onError?: (message: string) => void;
}

export function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export class VoiceSocket {
  readonly #socket: WebSocket;
  readonly #handlers: VoiceSocketHandlers;

  constructor(url: string, handlers: VoiceSocketHandlers) {
    this.#handlers = handlers;
    this.#socket = new WebSocket(url);
    this.#socket.binaryType = 'arraybuffer';

    this.#socket.onopen = () => handlers.onOpen?.();
    this.#socket.onerror = () => handlers.onError?.('The connection to the server failed.');
    this.#socket.onclose = (event) =>
      handlers.onClose?.({ clean: event.wasClean, reason: event.reason });
    this.#socket.onmessage = (event: MessageEvent<unknown>) => this.#receive(event.data);
  }

  get open(): boolean {
    return this.#socket.readyState === WebSocket.OPEN;
  }

  sendEvent(event: ClientEvent): void {
    if (!this.open) return;
    this.#socket.send(JSON.stringify(event));
  }

  sendAudio(frame: AudioFrame): void {
    if (!this.open) return;
    this.#socket.send(encodeAudioFrame(frame));
  }

  close(): void {
    this.#socket.close();
  }

  #receive(data: unknown): void {
    try {
      if (data instanceof ArrayBuffer) {
        this.#handlers.onAudio?.(decodeAudioFrame(data));
        return;
      }
      if (typeof data !== 'string') return;
      const parsed: unknown = JSON.parse(data);
      if (isServerEvent(parsed)) this.#handlers.onEvent?.(parsed);
    } catch (error) {
      // A malformed frame is a bug, not a reason to drop the session silently.
      this.#handlers.onError?.(
        error instanceof Error ? error.message : 'Received an unreadable message.',
      );
    }
  }
}
