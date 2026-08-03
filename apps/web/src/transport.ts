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
  /** Reconnection state, so the UI can say what is happening instead of freezing. */
  onStatus?: (status: SocketStatus) => void;
}

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Backoff between reconnection attempts, in ms.
 *
 * Starts fast because most drops on mobile are momentary — a tunnel, a handover
 * between cells, a screen lock — and an immediate retry usually succeeds. It then
 * backs off so a genuinely dead server is not hammered by every phone that ever
 * opened the page. Capped rather than unbounded so a session left open recovers
 * on its own when the network returns.
 */
const BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];

export function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export class VoiceSocket {
  readonly #url: string;
  readonly #handlers: VoiceSocketHandlers;
  #socket: WebSocket | undefined;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #closedByUs = false;

  constructor(url: string, handlers: VoiceSocketHandlers) {
    this.#url = url;
    this.#handlers = handlers;
    this.#connect();
  }

  get open(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  sendEvent(event: ClientEvent): void {
    if (!this.open) return;
    this.#socket?.send(JSON.stringify(event));
  }

  sendAudio(frame: AudioFrame): void {
    if (!this.open) return;
    this.#socket?.send(encodeAudioFrame(frame));
  }

  close(): void {
    // Distinguishes a deliberate close from a dropped one. Without it, ending a
    // session would trigger the reconnect loop and quietly reopen the microphone.
    this.#closedByUs = true;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#socket?.close();
    this.#handlers.onStatus?.('closed');
  }

  #connect(): void {
    this.#handlers.onStatus?.(this.#attempt === 0 ? 'connecting' : 'reconnecting');

    const socket = new WebSocket(this.#url);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#handlers.onStatus?.('open');
      this.#handlers.onOpen?.();
    };
    socket.onerror = () => this.#handlers.onError?.('The connection to the server failed.');
    socket.onmessage = (event: MessageEvent<unknown>) => this.#receive(event.data);
    socket.onclose = (event) => {
      this.#handlers.onClose?.({ clean: event.wasClean, reason: event.reason });
      if (this.#closedByUs) return;
      this.#scheduleRetry();
    };
  }

  #scheduleRetry(): void {
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 8_000;
    this.#attempt += 1;
    this.#handlers.onStatus?.('reconnecting');
    this.#retryTimer = setTimeout(() => {
      if (!this.#closedByUs) this.#connect();
    }, delay);
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
