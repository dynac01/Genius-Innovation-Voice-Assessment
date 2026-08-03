import { DEFAULT_CLAUDE_MODEL } from '@voice/core';
import type { PipelineAvailability, PipelineSelection, TurnState } from '@voice/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AudioEngine, MicrophoneError } from './audio/engine.js';
import type { MicPermission } from './audio/engine.js';
import { SessionLog, downloadLog } from './log.js';
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
  /**
   * Peak level reaching the speaker, 0–1.
   *
   * Shown because "the assistant is speaking" and "you can hear the assistant" are
   * different claims, and until this existed the app could only make the first one.
   */
  outputLevel: number;
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
  outputLevel: 0,
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
const DEFAULT_WANTED: PipelineSelection = {
  stt: 'fake',
  llm: 'fake',
  tts: 'fake',
  // Carried even while the fake is selected, so switching to a real model picks the
  // fastest one rather than landing on an empty menu value.
  llmModel: DEFAULT_CLAUDE_MODEL,
};

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

/**
 * The result of the speaker test.
 *
 * Deliberately reports what was *measured*, not what the app hopes happened. The
 * app can prove a tone was rendered; only the person in the room can say whether it
 * arrived. Separating those two facts is the entire value of the test, so the UI
 * states the measurement and asks for the other half rather than declaring success.
 */
export interface SpeakerTest {
  readonly peak: number;
  readonly rendered: boolean;
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
  /** Records captured so far, so the download control can show its own weight. */
  logSize: number;
  saveLog: () => void;
  /** Play a tone through the assistant's own output path. */
  testSpeaker: () => void;
  /** What the meter measured during the last test, or undefined if never run. */
  speakerTest: SpeakerTest | undefined;
} {
  const [state, setState] = useState<SessionState>(INITIAL);
  const [wanted, setWanted] = useState<PipelineSelection>(DEFAULT_WANTED);
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;

  const logRef = useRef(new SessionLog());
  // Records are pushed imperatively and read on demand; mirroring the whole log
  // into React state would re-render the tree on every audio frame. Only the count
  // is state, and only so the button can show it.
  const [logSize, setLogSize] = useState(0);
  const [speakerTest, setSpeakerTest] = useState<SpeakerTest | undefined>(undefined);
  useEffect(() => logRef.current.subscribe(() => setLogSize(logRef.current.size)), []);

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
    const log = logRef.current;
    log.reset();
    log.record('browser', 'session.start', { wanted: wantedRef.current, url: socketUrl() });

    const engine = new AudioEngine();
    engineRef.current = engine;
    const connectStartedAt = performance.now();

    /*
     * `hello` waits for both the socket and the microphone.
     *
     * The two start together on purpose — the permission prompt and the WebSocket
     * handshake have no reason to queue behind each other — but `hello` carries the
     * capture rate, and the rate does not exist until `getUserMedia` has resolved
     * and a context has been built around it. The socket opens in ~15ms and the
     * microphone takes far longer, so sending on open reliably announces a rate of
     * zero and leaves the server to guess.
     *
     * That guess was 16000, which was silently correct for exactly as long as the
     * browser was pinned to 16000, and became silently wrong the moment it wasn't:
     * the server declared 16kHz to a transcriber that was being fed 44.1kHz, which
     * it read as gibberish and answered with nothing. No error anywhere — just
     * frames going out and no transcript coming back.
     *
     * So the announcement is gated on both facts being true, whichever order they
     * arrive in, and the rate on the wire is now always one that was measured.
     */
    let announced = false;
    const announce = (): void => {
      if (announced || !socket.open || engine.sampleRate === 0) return;
      announced = true;
      const hello = {
        type: 'hello',
        sampleRate: engine.sampleRate,
        providers: wantedRef.current,
      } as const;
      log.record('browser', 'send.hello', hello);
      socket.sendEvent(hello);
      socket.sendEvent({ type: 'start' });
    };

    const socket = new VoiceSocket(socketUrl(), {
      onOpen: () => {
        setState((prev) => ({
          ...prev,
          connectMs: Math.round(performance.now() - connectStartedAt),
        }));
        announce();
      },
      onEvent: (event) => {
        // Recorded before it is handled, so the log shows what arrived even if
        // handling it throws. Audio frames are counted separately — they are
        // binary and do not pass through here.
        log.record('browser', `recv.${event.type}`, event);
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
            if (event.state === 'thinking') {
              newAssistantLineRef.current = true;
              // A new turn began, so the last turn's failure notice is stale.
              // Leaving it up makes a recovered session look permanently broken.
              setState((prev) => (prev.error === undefined ? prev : { ...prev, error: undefined }));
            }
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
          case 'log':
            // Re-tagged so a reader can tell the two halves apart, and dropped from
            // the browser-side record above so it appears once.
            log.recordServer(event.kind, event.data);
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
            /*
             * A provider hiccup ends a reply, not the session.
             *
             * This used to set `phase: 'error'`, which drives everything the UI
             * uses to decide whether a session is alive — the toggle flips back to
             * "Start session", the speaker test greys out, the meter stops. So one
             * failed clause presented as a dead app while the socket was still open
             * and the loop still able to take turns. The brief is explicit that a
             * hiccup should surface a failed earcon rather than hang, and a UI that
             * looks switched off is a worse outcome than hanging: it tells the user
             * to give up.
             *
             * Fatal errors still exist and still set the phase — a socket that
             * cannot be reached, a microphone that will not start. Those come from
             * the transport and engine handlers, not from here.
             */
            setState((prev) => ({ ...prev, error: event.message, lines: settleAll(prev.lines) }));
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
      onError: (message) => {
        log.record('browser', 'socket.error', { message });
        setState((prev) => ({ ...prev, phase: 'error', error: message }));
      },
      onStatus: (connection) => {
        log.record('browser', 'socket.status', { connection });
        setState((prev) => ({ ...prev, connection }));
      },
      // A dropped socket now reconnects on its own, so a close is not the end of
      // the session — the status field says which it is, and the phase only falls
      // back to idle once the socket is genuinely done.
      onClose: () => (
        log.record('browser', 'socket.close'),
        setState((prev) =>
          prev.phase === 'error' || prev.connection === 'reconnecting'
            ? prev
            : { ...prev, phase: 'idle' },
        )
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
        onLog: (kind, data) => log.record('browser', kind, data),
        onPermissionChange: (permission) => {
          log.record('browser', 'mic.permission', { permission });
          setState((prev) => ({ ...prev, permission }));
        },
        onBargeIn: (measurement) => {
          // Output is already silent by the time this runs. The socket is being
          // told what happened so the loop can decide what it *meant*.
          log.record('browser', 'audio.barge_in', {
            detectToSilentMs: Math.round(measurement.detectToSilent),
            onsetToSilentMs: Math.round(measurement.onsetToSilent),
          });
          socket.sendEvent({ type: 'interrupt', t: Math.round(performance.now()) });
          setState((prev) => ({
            ...prev,
            bargeInMs: Math.round(measurement.onsetToSilent),
            bargeIns: prev.bargeIns + 1,
          }));
        },
      })
      .then(() => {
        // The engine's own account of what it got. Every silent-audio fault so far
        // would have been visible in this one record.
        log.record('browser', 'engine.started', engine.describe());
        setState((prev) => ({ ...prev, sampleRate: engine.sampleRate }));
        // The other half of the gate: the microphone may well win this race.
        announce();
      })
      .catch((error: unknown) => {
        const message =
          error instanceof MicrophoneError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Could not start audio.';
        log.record('browser', 'engine.failed', { message });
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
      /*
       * The model menu sets two fields from one control.
       *
       * Its options are model ids rather than `'real'`, because a menu that reads
       * "Canned / Claude Haiku 4.5 / Claude Sonnet 5" is the honest description of
       * the choice being made. The selection type keeps them apart — `llm` is which
       * implementation, `llmModel` is which model — so the translation happens here,
       * at the edge, rather than by blurring the two on the wire.
       */
      const next =
        stage === 'llm' && value !== 'fake'
          ? ({ ...wantedRef.current, llm: 'real', llmModel: value } as PipelineSelection)
          : ({ ...wantedRef.current, [stage]: value } as PipelineSelection);
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

  /*
   * Poll the output meter on the display's own clock.
   *
   * A level is a continuous signal and React state is not, so this samples rather
   * than subscribes: rAF is already the rate at which a bar could visibly change,
   * and it parks itself when the tab is hidden. The `Math.round` is not cosmetic —
   * without it every frame is a distinct float and the whole tree re-renders 60
   * times a second for pixels nobody can tell apart.
   */
  useEffect(() => {
    if (state.phase !== 'running') return;
    let raf = 0;
    const sample = (): void => {
      const level = Math.round((engineRef.current?.outputLevel ?? 0) * 100) / 100;
      setState((prev) => (prev.outputLevel === level ? prev : { ...prev, outputLevel: level }));
      raf = requestAnimationFrame(sample);
    };
    raf = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(raf);
  }, [state.phase]);

  useEffect(() => () => stop(), [stop]);

  /**
   * Write the log to a file.
   *
   * The current UI state is folded in rather than left to be reconstructed from the
   * record stream: a reader should be able to see the counters that were on screen
   * when the report was made without replaying every event to derive them, and
   * those counters are the first thing anyone looks at.
   */
  /**
   * Play a tone and watch the meter while it plays.
   *
   * Sampled over the tone's own duration rather than read once: a single reading
   * can land in a zero crossing, and reporting "no signal" because of that would be
   * worse than not testing at all.
   */
  const testSpeaker = useCallback(() => {
    const engine = engineRef.current;
    if (engine === undefined) return;
    engine.playTestTone();
    setSpeakerTest(undefined);

    let peak = 0;
    const started = performance.now();
    const watch = window.setInterval(() => {
      peak = Math.max(peak, engine.outputLevel);
      if (performance.now() - started < 1_400) return;
      window.clearInterval(watch);
      const result = { peak: Math.round(peak * 1000) / 1000, rendered: peak > 0.005 };
      logRef.current.record('browser', 'audio.test_tone.result', result);
      setSpeakerTest(result);
    }, 40);
  }, []);

  const saveLog = useCallback(() => {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    logRef.current.record('browser', 'log.saved');
    downloadLog(
      `voice-session-${stamp}.json`,
      logRef.current.toJson({
        engine: engineRef.current?.describe() ?? { started: false },
        state: {
          phase: state.phase,
          turn: state.turn,
          connection: state.connection,
          permission: state.permission,
          captureRate: state.sampleRate,
          framesSent: state.framesSent,
          framesReceived: state.framesReceived,
          bargeIns: state.bargeIns,
          outputLevel: state.outputLevel,
          selected: state.selected,
          available: state.available,
          error: state.error,
        },
        conversation: state.lines,
      }),
    );
  }, [state]);

  return { state, wanted, start, stop, choose, logSize, saveLog, testSpeaker, speakerTest };
}
