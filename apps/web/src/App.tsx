import { useVoiceSession } from './useVoiceSession.js';

/**
 * Phase 2 — the vertical slice.
 *
 * Not the finished demo. This drives the round trip so the audio plumbing can be
 * verified by hand on a real device: microphone in, WebSocket out, fake pipeline,
 * audio back. The conversational UI arrives with the loop in Phase 3.
 */
const STAGES = [
  { key: 'stt', label: 'Speech-to-text', real: 'Deepgram Nova-3', fake: 'Scripted' },
  { key: 'llm', label: 'Model', real: 'Claude Haiku 4.5', fake: 'Canned' },
  { key: 'tts', label: 'Text-to-speech', real: 'Deepgram Aura-2', fake: 'Tone' },
] as const;

export function App() {
  const { state, wanted, start, stop, choose, logSize, saveLog } = useVoiceSession();

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

      <div className="controls">
        <button
          type="button"
          className="primary"
          data-testid="session-toggle"
          disabled={!ready}
          onClick={active ? stop : start}
        >
          {active ? 'Stop session' : 'Start session'}
        </button>

        {/*
          Enabled whenever there is anything to save, including after a session has
          stopped. A log you can only download while the thing is still running is
          the wrong shape for reporting a fault, because stopping is usually the
          first thing anyone does when something goes wrong.
        */}
        <button
          type="button"
          className="secondary"
          data-testid="download-log"
          disabled={logSize === 0}
          onClick={saveLog}
          title="Everything both sides of the socket did this session, as JSON"
        >
          Download logs{logSize > 0 && <span className="count">{logSize}</span>}
        </button>
      </div>

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

      {/*
        Provider choice lives here rather than in .env because swapping one is a
        thing to *demonstrate*, not a thing to redeploy. Changing a stage restarts
        the session — the pipeline is assembled when a session opens.
      */}
      <section className="providers" aria-label="Pipeline">
        <h2>Pipeline</h2>
        <div className="stage-grid">
          {STAGES.map((stage) => {
            // `undefined` means we have not been told yet — which is not the same
            // as "no key", and must not be rendered as if it were.
            const canBeReal = state.available?.[stage.key];
            const active = state.selected?.[stage.key];
            return (
              <label key={stage.key} className="stage">
                <span className="stage-label">{stage.label}</span>
                <select
                  data-testid={`provider-${stage.key}`}
                  value={wanted[stage.key]}
                  onChange={(e) => choose(stage.key, e.target.value)}
                >
                  <option value="fake">{stage.fake} (fake)</option>
                  {stage.key === 'tts' && <option value="silent">Silent (fake)</option>}
                  <option value="real" disabled={canBeReal === false}>
                    {stage.real}
                    {canBeReal === false ? ' — no key' : ''}
                  </option>
                </select>
                {/* What loaded, not what was asked for. */}
                {active !== undefined && active !== wanted[stage.key] && (
                  <span className="stage-note" data-testid={`provider-${stage.key}-actual`}>
                    running as {active}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </section>

      {/*
        Output meter: the samples actually reaching the speaker.

        Deliberately given real estate rather than a slot in the stats grid. Every
        other indicator here reports something the app *did* — frames sent, frames
        received, a turn state — and all of them read healthy while the assistant is
        inaudible. This is the only one that reports what left the machine, which
        makes it the one that separates "the app is broken" from "the sound is going
        somewhere else". It doubles as the clearest view of a barge-in: the bar
        collapses to nothing the moment you speak.
      */}
      <section className="meter" aria-label="Assistant output level">
        <div className="meter-head">
          <span>Speaker output</span>
          <span className="meter-hint" data-testid="output-level">
            {state.phase !== 'running'
              ? 'idle'
              : state.outputLevel > 0.01
                ? 'sound is leaving the browser'
                : 'silent'}
          </span>
        </div>
        <div
          className="meter-track"
          role="meter"
          aria-valuenow={Math.round(state.outputLevel * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="meter-fill"
            style={{ width: `${Math.min(100, state.outputLevel * 140).toFixed(0)}%` }}
          />
        </div>
      </section>

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

      <section className="transcript" aria-label="Conversation">
        <h2>Conversation</h2>

        {state.lines.length === 0 ? (
          <p className="muted small" data-testid="transcript-empty">
            {state.phase === 'running' ? 'Listening…' : 'Start a session and say something.'}
          </p>
        ) : (
          <ol className="turns" data-testid="transcript">
            {state.lines.map((line, index) => (
              <li
                key={line.id}
                className={`turn turn-${line.role}`}
                data-testid={`turn-${line.role}`}
                data-role={line.role}
                data-pending={line.pending}
                data-interrupted={line.interrupted}
              >
                <span className="who">{line.role === 'user' ? 'You' : 'Assistant'}</span>
                <span className="said">
                  {line.text}
                  {line.pending && index === state.lines.length - 1 && (
                    <span className="caret" aria-hidden="true" />
                  )}
                  {line.interrupted && <span className="cut"> — interrupted</span>}
                </span>
              </li>
            ))}
          </ol>
        )}

        <p className="muted small">
          Last earcon: <span data-testid="last-earcon">{state.lastEarcon ?? '—'}</span> (
          <span data-testid="earcon-count">{state.earconCount}</span> played)
        </p>
      </section>
    </main>
  );
}
