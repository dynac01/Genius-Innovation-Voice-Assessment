import type { PipelineAvailability, PipelineSelection, TurnState } from '@voice/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AudioEngine, MicrophoneError } from './audio/engine.js';
import type { MicPermission } from './audio/engine.js';
import { VoiceSocket, socketUrl } from './transport.js';
import type { SocketStatus } from './transport.js';

export type SessionPhase = 'idle' | 'starting' | 'running' | 'error';

/**
 * One turn in the conversation.
 *
 * The previous shape was two strings — the latest user transcript, and every
 * assistant reply ever concatenated together. Across more than one turn that is
 * not a transcript, it is a blob: no speaker boundaries, no turn boundaries, and
 * an assistant "message" that grows without end. A conversation is a list of
 * turns, so the state is a list of turns.
 */
export interface Line {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  text: string;
  /** Still being spoken or still being generated — rendered as in-progress. */
  pending: boolean;
  /** The reply was cut off. Shown, because a truncated answer is information. */
  interrupted: boolean;
}

export interface SessionState {
  phase: SessionPhase;
  turn: TurnState;
  permission: MicPermission;
  error: string | undefined;
  lines: Line[];
  lastEarcon: string | undefined;
  earconCount: number;
  sampleRate: number;
  framesSent: number;
  framesReceived: number;
  /** Final transcript → first assistant audio. The baseline Phase 2 records. */
  responseLatencyMs: number | undefined;
  connectMs: number | undefined;
  /** Measured barge-in: user onset → assistant audio silent. */
  bargeInMs: number | undefined;
  bargeIns: number;
  connection: SocketStatus;
  /** What the server actually resolved — not necessarily what was requested. */
  selected: PipelineSelection | undefined;
  /**
   * Which stages the server has keys for, or `undefined` until it has told us.
   *
   * The distinction matters: "we have not asked yet" is not "there is no key",
   * and rendering the second when you mean the first tells the user their
   * configuration is broken when it is fine.
   */
  available: PipelineAvailability | undefined;
}

const INITIAL: SessionState = {
  phase: 'idle',
  turn: 'idle',
  permission: 'unknown',
  error: undefined,
  lines: [],
  lastEarcon: undefined,
  earconCount: 0,
  sampleRate: 0,
  framesSent: 0,
  framesReceived: 0,
  responseLatencyMs: undefined,
  connectMs: undefined,
  bargeInMs: undefined,
  bargeIns: 0,
  connection: 'closed',
  selected: undefined,
  available: undefined,
};

/**
 * Wires the audio engine to the socket and exposes what the UI needs.
 *
 * Phase 2 scope: prove the round trip. There is no barge-in detection here yet and
 * no turn logic — the server drives state, the browser plays what arrives. Phases 3
 * and 4 add the parts that make it a conversation.
 */
const DEFAULT_WANTED: PipelineSelection = { stt: 'fake', llm: 'fake', tts: 'fake' };

/**
 * Only the newest line can be in progress.
 *
 * Enforced when a line is added rather than hoped for: a turn that never received
 * its closing signal — a transcript superseded before its final arrived, a reply
 * cut off — would otherwise keep a blinking cursor for the rest of the session,
 * and they accumulate.
 */
function settleAll(lines: Line[]): Line[] {
  return lines.map((line) => (line.pending ? { ...line, pending: false } : line));
}

interface HealthResponse {
  readonly pipeline?: {
    readonly default?: PipelineSelection;
    readonly available?: PipelineAvailability;
  };
}

export function useVoiceSession(): {
  state: SessionState;
  wanted: PipelineSelection;
  start: () => void;
  stop: () => void;
  choose: (stage: keyof PipelineSelection, value: string) => void;
} {
  const [state, setState] = useState<SessionState>(INITIAL);
  const [wanted, setWanted] = useState<PipelineSelection>(DEFAULT_WANTED);
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;

  const engineRef = useRef<AudioEngine | undefined>(undefined);
  const socketRef = useRef<VoiceSocket | undefined>(undefined);
  const seqRef = useRef(0);
  const finalAtRef = useRef<number | undefined>(undefined);
  const startingRef = useRef(false);
  const lineIdRef = useRef(0);
  // Set when the assistant begins a turn, so its first delta opens a new line
  // instead of extending the previous reply.
  const newAssistantLineRef = useRef(true);

  const stop = useCallback(() => {
    socketRef.current?.sendEvent({ type: 'stop' });
    socketRef.current?.close();
    socketRef.current = undefined;
    void engineRef.current?.stop();
    engineRef.current = undefined;
    startingRef.current = false;
    seqRef.current = 0;
    finalAtRef.current = undefined;
    lineIdRef.current = 0;
    newAssistantLineRef.current = true;
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
        socket.sendEvent({
          type: 'hello',
          sampleRate: engine.sampleRate,
          providers: wantedRef.current,
        });
        socket.sendEvent({ type: 'start' });
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'ready':
            setState((prev) => ({
              ...prev,
              phase: 'running',
              available: event.available,
              selected: event.selected,
            }));
            break;
          case 'state':
            if (event.state === 'thinking') newAssistantLineRef.current = true;
            // A reply that finished normally is no longer in progress. Nothing was
            // clearing this, so every completed assistant turn kept its cursor and
            // the page filled up with them.
            if (event.state === 'listening' || event.state === 'idle') {
              setState((prev) => ({ ...prev, lines: settleAll(prev.lines) }));
            }
            // The assistant claims the turn the moment it starts thinking, not
            // when audio appears — otherwise talking over it mid-composition
            // does nothing at all.
            engine.setAssistantActive(event.state === 'thinking' || event.state === 'speaking');
            setState((prev) => ({ ...prev, turn: event.state }));
            break;

          case 'transcript': {
            if (event.final) finalAtRef.current = performance.now();
            setState((prev) => {
              const lines = [...prev.lines];
              const last = lines[lines.length - 1];
              if (last?.role === 'user' && last.pending) {
                lines[lines.length - 1] = { ...last, text: event.text, pending: !event.final };
              } else {
                lineIdRef.current += 1;
                settleAll(lines).forEach((l, i) => (lines[i] = l));
                lines.push({
                  id: lineIdRef.current,
                  role: 'user',
                  text: event.text,
                  pending: !event.final,
                  interrupted: false,
                });
              }
              return { ...prev, lines };
            });
            break;
          }

          case 'assistant_text': {
            const startNew = newAssistantLineRef.current;
            newAssistantLineRef.current = false;
            setState((prev) => {
              const lines = [...prev.lines];
              const last = lines[lines.length - 1];
              if (!startNew && last?.role === 'assistant') {
                lines[lines.length - 1] = { ...last, text: last.text + event.text };
              } else {
                lineIdRef.current += 1;
                settleAll(lines).forEach((l, i) => (lines[i] = l));
                lines.push({
                  id: lineIdRef.current,
                  role: 'assistant',
                  text: event.text,
                  pending: true,
                  interrupted: false,
                });
              }
              return { ...prev, lines };
            });
            break;
          }
          case 'earcon':
            engine.playEarcon(event.sound);
            setState((prev) => ({
              ...prev,
              lastEarcon: event.sound,
              earconCount: prev.earconCount + 1,
            }));
            break;
          case 'flush_audio':
            engine.flush();
            // The reply was cut off mid-sentence; say so rather than leaving a
            // truncated line that reads like the assistant simply stopped.
            setState((prev) => {
              const lines = [...prev.lines];
              const last = lines[lines.length - 1];
              if (last?.role === 'assistant' && last.pending) {
                lines[lines.length - 1] = { ...last, pending: false, interrupted: true };
              }
              return { ...prev, lines };
            });
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
      onStatus: (connection) => setState((prev) => ({ ...prev, connection })),
      // A dropped socket now reconnects on its own, so a close is not the end of
      // the session — the status field says which it is, and the phase only falls
      // back to idle once the socket is genuinely done.
      onClose: () =>
        setState((prev) =>
          prev.phase === 'error' || prev.connection === 'reconnecting'
            ? prev
            : { ...prev, phase: 'idle' },
        ),
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
        onBargeIn: (measurement) => {
          // Output is already silent by the time this runs. The socket is being
          // told what happened so the loop can decide what it *meant*.
          socket.sendEvent({ type: 'interrupt', t: Math.round(performance.now()) });
          setState((prev) => ({
            ...prev,
            bargeInMs: Math.round(measurement.onsetToSilent),
            bargeIns: prev.bargeIns + 1,
          }));
        },
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

  /**
   * Changing a stage restarts the session.
   *
   * The pipeline is assembled when a session opens, so a live swap means a new
   * session — which is the honest thing anyway: criterion 7 is "run it once with
   * a real provider and once with the fake", and a restart is what that *is*. One
   * click rather than editing a file and restarting a server.
   */
  const choose = useCallback(
    (stage: keyof PipelineSelection, value: string) => {
      const next = { ...wantedRef.current, [stage]: value } as PipelineSelection;
      setWanted(next);
      wantedRef.current = next;
      if (socketRef.current !== undefined) {
        stop();
        // After the teardown settles, so the new socket is not racing the old one.
        setTimeout(() => start(), 120);
      }
    },
    [start, stop],
  );

  /**
   * Ask what the server can offer, before any session exists.
   *
   * Availability used to arrive only in the `ready` message, which requires an
   * open socket — so the controls rendered "no key" for every stage until you
   * pressed Start, regardless of what was configured. The server has always
   * published this at /health; nothing was asking.
   *
   * The server's own default also seeds the controls, so the app opens configured
   * the way it was deployed rather than always falling back to fakes.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/health');
        if (!response.ok) return;
        const body = (await response.json()) as HealthResponse;
        if (cancelled) return;
        const available = body.pipeline?.available;
        const preset = body.pipeline?.default;
        if (available !== undefined) setState((prev) => ({ ...prev, available }));
        if (preset !== undefined) {
          setWanted(preset);
          wantedRef.current = preset;
        }
      } catch {
        // Leave availability unknown rather than asserting a key is missing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { state, wanted, start, stop, choose };
}
