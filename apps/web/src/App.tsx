import { CORE_STATUS } from '@voice/core';

/**
 * Phase 0 placeholder. The real demo — mic capture, playback, local VAD, earcons,
 * transcript — lands in Phase 2 onward. This exists to prove the app builds, renders,
 * and can import from @voice/core.
 */
export function App() {
  const secureContext = window.isSecureContext;
  const hasMediaDevices = typeof navigator.mediaDevices?.getUserMedia === 'function';
  const hasAudioWorklet = typeof AudioWorkletNode !== 'undefined';

  return (
    <main
      style={{
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        maxWidth: '32rem',
        margin: '0 auto',
        padding: '2rem 1.25rem',
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: '1.25rem', marginBottom: '0.25rem' }}>Voice Conversation</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>Phase 0 — {CORE_STATUS}</p>

      {/*
        These three checks are the preconditions for the entire demo. Surfacing them
        here means a Codespace or mobile browser that cannot support the audio path
        says so immediately, rather than failing opaquely once capture starts.
      */}
      <ul style={{ paddingLeft: '1.1rem' }}>
        <li>Secure context (HTTPS or localhost): {secureContext ? 'yes' : 'no'}</li>
        <li>getUserMedia available: {hasMediaDevices ? 'yes' : 'no'}</li>
        <li>AudioWorklet available: {hasAudioWorklet ? 'yes' : 'no'}</li>
      </ul>
    </main>
  );
}
