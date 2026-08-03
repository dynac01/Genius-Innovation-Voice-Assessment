import type { TurnState } from '@voice/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AudioEngine, MicrophoneError } from './audio/engine.js';
import type { MicPermission } from './audio/engine.js';
import { VoiceSocket, socketUrl } from './transport.js';

export type SessionPhase = 'idle' | 'starting' | 'running' | 'error';

export interface SessionState {
  phase: SessionPhase;
  turn: TurnState;
  permission: MicPermission;
  error: string | undefined;
  userText: string;
  assistantText: string;
  lastEarcon: string | undefined;
  sampleRate: number;
  framesSent: number;
  framesReceived: number;
  /** Final transcript → first assistant audio. The baseline Phase 2 records. */
  responseLatencyMs: number | undefined;
  connectMs: number | undefined;
}

const INITIAL: SessionState = {
  phase: 'idle',
  turn: 'idle',
  permission: 'unknown',
  error: undefined,
  userText: '',
  assistantText: '',
  lastEarcon: undefined,
  sampleRate: 0,
  framesSent: 0,
  framesReceived: 0,
  responseLatencyMs: undefined,
  connectMs: undefined,
};

/**
 * Wires the audio engine to the socket and exposes what the UI needs.
 *
 * Phase 2 scope: prove the round trip. There is no barge-in detection here yet and
 * no turn logic — the server drives state, the browser plays what arrives. Phases 3
 * and 4 add the parts that make it a conversation.
 */
export function useVoiceSession(): {
  state: SessionState;
  start: () => void;
  stop: () => void;
} {
  const [state, setState] = useState<SessionState>(INITIAL);

  const engineRef = useRef<AudioEngine | undefined>(undefined);
  const socketRef = useRef<VoiceSocket | undefined>(undefined);
  const seqRef = useRef(0);
  const finalAtRef = useRef<number | undefined>(undefined);
  const startingRef = useRef(false);

  const stop = useCallback(() => {
    socketRef.current?.sendEvent({ type: 'stop' });
    socketRef.current?.close();
    socketRef.current = undefined;
    void engineRef.current?.stop();
    engineRef.current = undefined;
    startingRef.current = false;
    seqRef.current = 0;
    finalAtRef.current = undefined;
    setState((prev) => ({ ...INITIAL, permission: prev.permission }));
  }, []);

  const start = useCallback(() => {
    // React 19 StrictMode invokes effects twice in development; without this guard
    // the second pass opens a second microphone and a second socket.
    if (startingRef.current) return;
    startingRef.current = true;

    setState({ ...INITIAL, phase: 'starting' });
    const engine = new AudioEngine();
    engineRef.current = engine;
    const connectStartedAt = performance.now();

    const socket = new VoiceSocket(socketUrl(), {
      onOpen: () => {
        setState((prev) => ({
          ...prev,
          connectMs: Math.round(performance.now() - connectStartedAt),
        }));
        socket.sendEvent({ type: 'hello', sampleRate: engine.sampleRate });
        socket.sendEvent({ type: 'start' });
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'ready':
            setState((prev) => ({ ...prev, phase: 'running' }));
            break;
          case 'state':
            setState((prev) => ({ ...prev, turn: event.state }));
            break;
          case 'transcript':
            if (event.final) finalAtRef.current = performance.now();
            setState((prev) => ({ ...prev, userText: event.text }));
            break;
          case 'assistant_text':
            setState((prev) => ({ ...prev, assistantText: prev.assistantText + event.text }));
            break;
          case 'earcon':
            setState((prev) => ({ ...prev, lastEarcon: event.sound }));
            break;
          case 'flush_audio':
            engine.flush();
            break;
          case 'error':
            setState((prev) => ({ ...prev, phase: 'error', error: event.message }));
            break;
        }
      },
      onAudio: (frame) => {
        engine.play(frame.pcm, 24_000);
        setState((prev) => ({
          ...prev,
          framesReceived: prev.framesReceived + 1,
          responseLatencyMs:
            prev.responseLatencyMs ??
            (finalAtRef.current === undefined
              ? undefined
              : Math.round(performance.now() - finalAtRef.current)),
        }));
      },
      onError: (message) => setState((prev) => ({ ...prev, phase: 'error', error: message })),
      onClose: () =>
        setState((prev) => (prev.phase === 'error' ? prev : { ...prev, phase: 'idle' })),
    });
    socketRef.current = socket;

    void engine
      .start({
        onFrame: (pcm) => {
          socket.sendAudio({ seq: seqRef.current, pcm });
          seqRef.current += 1;
          setState((prev) => ({ ...prev, framesSent: prev.framesSent + 1 }));
        },
        onPermissionChange: (permission) => setState((prev) => ({ ...prev, permission })),
      })
      .then(() => {
        setState((prev) => ({ ...prev, sampleRate: engine.sampleRate }));
      })
      .catch((error: unknown) => {
        const message =
          error instanceof MicrophoneError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Could not start audio.';
        setState((prev) => ({ ...prev, phase: 'error', error: message }));
        socket.close();
        startingRef.current = false;
      });
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { state, start, stop };
}
