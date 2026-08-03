import { EARCONS } from '@voice/core';
import type { EarconSound, EarconTone } from '@voice/core';

/**
 * Renders earcon specs as Web Audio.
 *
 * Carries no decisions — every frequency, duration and envelope comes from
 * @voice/core, where it is asserted against the brief's requirements. This file
 * only turns that data into oscillators, which is why there is nothing here worth
 * unit testing and nothing here that can drift from the spec.
 *
 * The output node is the important part: earcons are mixed **in parallel** with
 * speech, never through it. A barge-in ramps the speech gain to zero and cannot
 * touch a `failed` tone; a `ready` chime cannot duck the reply behind it. The brief
 * asks for earcons "injected into the output without clobbering speech", and a
 * separate node is what makes that structural rather than a matter of tuning.
 */
export class EarconPlayer {
  readonly #context: AudioContext;
  readonly #output: GainNode;

  constructor(context: AudioContext) {
    this.#context = context;
    this.#output = context.createGain();
    this.#output.gain.value = 1;
    this.#output.connect(context.destination);
  }

  play(sound: EarconSound): void {
    const spec = EARCONS[sound];
    const now = this.#context.currentTime;
    for (const tone of spec.tones) this.#playTone(tone, now + tone.startMs / 1000);
  }

  disconnect(): void {
    this.#output.disconnect();
  }

  #playTone(tone: EarconTone, startAt: number): void {
    const osc = this.#context.createOscillator();
    // Sine only. A square or saw carries harmonics that read as harsh at any volume,
    // and these play often enough that harshness compounds.
    osc.type = 'sine';
    osc.frequency.setValueAtTime(tone.fromHz, startAt);
    if (tone.toHz !== tone.fromHz) {
      osc.frequency.linearRampToValueAtTime(tone.toHz, startAt + tone.durationMs / 1000);
    }

    const envelope = this.#context.createGain();
    const attackEnd = startAt + tone.attackMs / 1000;
    const sustainEnd = startAt + tone.durationMs / 1000;
    const releaseEnd = sustainEnd + tone.releaseMs / 1000;

    // Ramp in and out rather than switching on. Starting at a non-zero sample is a
    // click, which is both audible and exactly the artefact the barge-in ramp exists
    // to avoid — no reason to reintroduce it here.
    envelope.gain.setValueAtTime(0, startAt);
    envelope.gain.linearRampToValueAtTime(tone.peak, attackEnd);
    envelope.gain.setValueAtTime(tone.peak, sustainEnd);
    envelope.gain.linearRampToValueAtTime(0, releaseEnd);

    osc.connect(envelope);
    envelope.connect(this.#output);

    osc.start(startAt);
    osc.stop(releaseEnd);
    osc.onended = () => {
      osc.disconnect();
      envelope.disconnect();
    };
  }
}
