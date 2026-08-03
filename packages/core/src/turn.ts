/**
 * The turn state machine.
 *
 * Pure and total: every (state, event) pair has a defined answer, and the answer to
 * an illegal pair is `undefined` rather than a thrown error or a silent no-op. The
 * loop logs and ignores those, which means a protocol bug shows up as a rejected
 * transition in one place instead of as a state that quietly drifts.
 *
 *   idle ──start──▶ listening ──endpoint──▶ thinking ──audio──▶ speaking
 *     ▲                  ▲   ▲                  │                   │
 *     │                  │   └──── resume ──────┤                   │
 *     └──────stop────────┴──────reply_done──────┴───────────────────┘
 *
 * `interrupt` is legal only while speaking — that is what barge-in *is*, and a
 * barge-in against a machine that is not talking is a bug worth surfacing.
 */

export type TurnState = 'idle' | 'listening' | 'thinking' | 'speaking';

export type TurnEvent =
  /** Session opened; begin capturing. */
  | { type: 'start' }
  /** End of turn detected — the user has stopped speaking. */
  | { type: 'endpoint' }
  /** First audio of the reply is on its way to the speaker. */
  | { type: 'audio' }
  /** The reply finished on its own terms. */
  | { type: 'reply_done' }
  /** The user began speaking over the assistant. */
  | { type: 'interrupt' }
  /** A paused reply is being picked back up from where the user stopped hearing it. */
  | { type: 'resume' }
  /** Session closing. */
  | { type: 'stop' };

const TRANSITIONS: Record<TurnState, Partial<Record<TurnEvent['type'], TurnState>>> = {
  idle: {
    start: 'listening',
    stop: 'idle',
  },
  listening: {
    endpoint: 'thinking',
    // Resuming re-enters the reply from listening, which is where an interrupt left
    // the machine. It is distinct from `endpoint`: no new utterance is being answered.
    resume: 'thinking',
    stop: 'idle',
  },
  thinking: {
    audio: 'speaking',
    resume: 'thinking',
    // A reply that produced no audio at all still ends the turn rather than wedging.
    reply_done: 'listening',
    interrupt: 'listening',
    stop: 'idle',
  },
  speaking: {
    reply_done: 'listening',
    interrupt: 'listening',
    // More audio while already speaking is the normal case, not a transition.
    audio: 'speaking',
    stop: 'idle',
  },
};

/** The next state, or `undefined` when the event is not legal from here. */
export function transition(from: TurnState, event: TurnEvent): TurnState | undefined {
  return TRANSITIONS[from][event.type];
}

/** Whether an event is accepted in the given state. */
export function accepts(from: TurnState, event: TurnEvent): boolean {
  return transition(from, event) !== undefined;
}

/**
 * A tiny holder so callers do not each reimplement "apply if legal".
 * Deliberately not an event emitter — the loop decides what a change means.
 */
export class TurnMachine {
  #state: TurnState;

  constructor(initial: TurnState = 'idle') {
    this.#state = initial;
  }

  get state(): TurnState {
    return this.#state;
  }

  /** Apply an event. Returns the new state, or `undefined` if it was rejected. */
  apply(event: TurnEvent): TurnState | undefined {
    const next = transition(this.#state, event);
    if (next === undefined) return undefined;
    this.#state = next;
    return next;
  }
}
