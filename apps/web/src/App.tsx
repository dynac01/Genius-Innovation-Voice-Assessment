import { useVoiceSession } from './useVoiceSession.js';

/**
 * Phase 2 — the vertical slice.
 *
 * Not the finished demo. This drives the round trip so the audio plumbing can be
 * verified by hand on a real device: microphone in, WebSocket out, fake pipeline,
 * audio back. The conversational UI arrives with the loop in Phase 3.
 */
export function App() {
  const { state, start, stop } = useVoiceSession();

  const secureContext = window.isSecureContext;
  const hasMediaDevices = typeof navigator.mediaDevices?.getUserMedia === 'function';
  const hasAudioWorklet = typeof AudioWorkletNode !== 'undefined';
  const ready = secureContext && hasMediaDevices && hasAudioWorklet;
  const active = state.phase === 'running' || state.phase === 'starting';

  return (
    <main className="shell">
      <header>
        <h1>Voice Conversation</h1>
        <p className="muted">Phase 2 — vertical slice</p>
      </header>

      {/*
        The preconditions for the entire audio path. Surfacing them here means a
        Codespace or an older mobile browser says so immediately, rather than
        failing opaquely once capture starts.
      */}
      <ul className="checks" data-testid="capabilities">
        <li data-testid="cap-secure-context" data-ok={secureContext}>
          Secure context (HTTPS or localhost): {secureContext ? 'yes' : 'no'}
        </li>
        <li data-testid="cap-get-user-media" data-ok={hasMediaDevices}>
          getUserMedia available: {hasMediaDevices ? 'yes' : 'no'}
        </li>
        <li data-testid="cap-audio-worklet" data-ok={hasAudioWorklet}>
          AudioWorklet available: {hasAudioWorklet ? 'yes' : 'no'}
        </li>
      </ul>

      <button
        type="button"
        className="primary"
        data-testid="session-toggle"
        disabled={!ready}
        onClick={active ? stop : start}
      >
        {active ? 'Stop session' : 'Start session'}
      </button>

      {state.error !== undefined && (
        <p className="error" role="alert" data-testid="error">
          {state.error}
        </p>
      )}

      {state.connection === 'reconnecting' && (
        <p className="notice" role="status" data-testid="reconnecting">
          Connection lost — reconnecting…
        </p>
      )}

      <dl className="stats" data-testid="stats">
        <div>
          <dt>Phase</dt>
          <dd data-testid="phase">{state.phase}</dd>
        </div>
        <div>
          <dt>Turn</dt>
          <dd data-testid="turn">{state.turn}</dd>
        </div>
        <div>
          <dt>Connection</dt>
          <dd data-testid="connection">{state.connection}</dd>
        </div>
        <div>
          <dt>Mic</dt>
          <dd data-testid="permission">{state.permission}</dd>
        </div>
        <div>
          <dt>Capture rate</dt>
          <dd>{state.sampleRate === 0 ? '—' : `${state.sampleRate} Hz`}</dd>
        </div>
        <div>
          <dt>Frames sent</dt>
          <dd data-testid="frames-sent">{state.framesSent}</dd>
        </div>
        <div>
          <dt>Frames received</dt>
          <dd data-testid="frames-received">{state.framesReceived}</dd>
        </div>
        <div>
          <dt>Connect</dt>
          <dd>{state.connectMs === undefined ? '—' : `${state.connectMs} ms`}</dd>
        </div>
        <div>
          <dt>Barge-in stop</dt>
          <dd data-testid="barge-in-ms">
            {state.bargeInMs === undefined ? '—' : `${state.bargeInMs} ms`}
          </dd>
        </div>
        <div>
          <dt>Barge-ins</dt>
          <dd data-testid="barge-in-count">{state.bargeIns}</dd>
        </div>
        <div>
          <dt>Transcript → audio</dt>
          <dd data-testid="response-latency">
            {state.responseLatencyMs === undefined ? '—' : `${state.responseLatencyMs} ms`}
          </dd>
        </div>
      </dl>

      <section className="transcript">
        <h2>Transcript</h2>
        <p className="line">
          <span className="who">You</span>
          <span data-testid="user-text">{state.userText || '…'}</span>
        </p>
        <p className="line">
          <span className="who">Assistant</span>
          <span data-testid="assistant-text">{state.assistantText || '…'}</span>
        </p>
        <p className="muted small">
          Last earcon: <span data-testid="last-earcon">{state.lastEarcon ?? '—'}</span> (
          <span data-testid="earcon-count">{state.earconCount}</span> played)
        </p>
      </section>
    </main>
  );
}
