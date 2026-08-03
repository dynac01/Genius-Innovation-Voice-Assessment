import { AudioBridge, StubDialog, VirtualClock } from '@voice/core';
import type { BridgeEvent, Pipeline } from '@voice/core';
import { CannedLlm, ScriptedStt, SilentTts, fakeMicrophone } from '@voice/providers';
import type { SttScriptStep } from '@voice/providers';

/**
 * Shared rig for the feature tier: a real bridge and a real stub dialog, wired to
 * the three fakes, on virtual time. Nothing here is mocked except the providers.
 */

export interface Stamped {
  event: BridgeEvent;
  at: number;
}

export interface HarnessOptions {
  script: SttScriptStep[];
  reply: string;
  micMs?: number;
  endOfTurnMs?: number;
  pauseMs?: number;
  ttftMs?: number;
  interTokenMs?: number;
  /** Called on every event, so a test can interrupt at a chosen moment. */
  onEvent?: (event: BridgeEvent, ctx: { bridge: AudioBridge; clock: VirtualClock }) => void;
}

export interface Harness {
  clock: VirtualClock;
  bridge: AudioBridge;
  dialog: StubDialog;
  llm: CannedLlm;
  tts: SilentTts;
  events: Stamped[];
  warnings: string[];
  run: () => Promise<void>;
}

export function harness(options: HarnessOptions): Harness {
  const clock = new VirtualClock();
  const events: Stamped[] = [];
  const warnings: string[] = [];

  const stt = new ScriptedStt({ clock, script: options.script });
  const llm = new CannedLlm({
    clock,
    reply: options.reply,
    ttftMs: options.ttftMs ?? 100,
    interTokenMs: options.interTokenMs ?? 25,
  });
  const tts = new SilentTts({ clock, ttfbMs: 40, frameMs: 20 });
  const pipeline: Pipeline = { stt, llm, tts };
  const dialog = new StubDialog({ llm });

  const bridge: AudioBridge = new AudioBridge({
    pipeline,
    dialog,
    clock,
    endpointer: {
      endOfTurnMs: options.endOfTurnMs ?? 700,
      pauseMs: options.pauseMs ?? 300,
      trustSttFinal: true,
    },
    onEvent: (event) => {
      events.push({ event, at: clock.now() });
      options.onEvent?.(event, { bridge, clock });
    },
    onWarning: (message) => warnings.push(message),
  });

  return {
    clock,
    bridge,
    dialog,
    llm,
    tts,
    events,
    warnings,
    run: async () => {
      const running = bridge.run(fakeMicrophone({ clock, durationMs: options.micMs ?? 6_000 }));
      await clock.runUntilIdle();
      await running;
    },
  };
}

export const states = (events: Stamped[]): string[] =>
  events.filter((e) => e.event.type === 'state').map((e) => (e.event as { state: string }).state);

export const earcons = (events: Stamped[]): string[] =>
  events.filter((e) => e.event.type === 'earcon').map((e) => (e.event as { sound: string }).sound);

export const audio = (events: Stamped[]): Stamped[] =>
  events.filter((e) => e.event.type === 'audio');

export const spoken = (events: Stamped[]): string =>
  events
    .filter((e) => e.event.type === 'assistant_text')
    .map((e) => (e.event as { text: string }).text)
    .join('');

export const firstAt = (events: Stamped[], type: BridgeEvent['type']): number | undefined =>
  events.find((e) => e.event.type === type)?.at;
