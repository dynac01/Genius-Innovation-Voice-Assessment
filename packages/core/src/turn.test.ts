import { describe, expect, it } from 'vitest';

import type { TurnEvent, TurnState } from './turn.js';
import { TurnMachine, accepts, transition } from './turn.js';

const STATES: TurnState[] = ['idle', 'listening', 'thinking', 'speaking'];
const EVENTS: TurnEvent['type'][] = [
  'start',
  'endpoint',
  'audio',
  'reply_done',
  'interrupt',
  'stop',
];

describe('turn transitions', () => {
  it.each([
    ['idle', 'start', 'listening'],
    ['listening', 'endpoint', 'thinking'],
    ['thinking', 'audio', 'speaking'],
    ['speaking', 'reply_done', 'listening'],
    ['speaking', 'audio', 'speaking'],
    ['speaking', 'interrupt', 'listening'],
    ['thinking', 'interrupt', 'listening'],
    ['thinking', 'reply_done', 'listening'],
  ] as const)('%s + %s -> %s', (from, type, expected) => {
    expect(transition(from, { type } as TurnEvent)).toBe(expected);
  });

  it.each([
    ['idle', 'endpoint'],
    ['idle', 'audio'],
    ['idle', 'interrupt'],
    ['idle', 'reply_done'],
    ['listening', 'start'],
    ['listening', 'audio'],
    ['listening', 'interrupt'],
    ['listening', 'reply_done'],
    ['thinking', 'start'],
    ['thinking', 'endpoint'],
    ['speaking', 'start'],
    ['speaking', 'endpoint'],
  ] as const)('rejects %s + %s', (from, type) => {
    expect(transition(from, { type } as TurnEvent)).toBeUndefined();
    expect(accepts(from, { type } as TurnEvent)).toBe(false);
  });

  /**
   * Barge-in against a machine that is not talking is a bug, not a no-op. Making
   * `interrupt` illegal outside thinking/speaking means it surfaces as a rejected
   * transition in one place rather than as state that quietly drifts.
   */
  it('accepts interrupt only while a reply is in flight', () => {
    for (const state of STATES) {
      const expected = state === 'thinking' || state === 'speaking';
      expect(accepts(state, { type: 'interrupt' }), state).toBe(expected);
    }
  });

  it('accepts stop from every state', () => {
    for (const state of STATES) {
      expect(transition(state, { type: 'stop' }), state).toBe('idle');
    }
  });

  it('is total — every pair has a defined answer', () => {
    for (const state of STATES) {
      for (const type of EVENTS) {
        expect(() => transition(state, { type } as TurnEvent)).not.toThrow();
      }
    }
  });
});

describe('TurnMachine', () => {
  it('walks a whole turn', () => {
    const machine = new TurnMachine();
    expect(machine.state).toBe('idle');
    expect(machine.apply({ type: 'start' })).toBe('listening');
    expect(machine.apply({ type: 'endpoint' })).toBe('thinking');
    expect(machine.apply({ type: 'audio' })).toBe('speaking');
    expect(machine.apply({ type: 'reply_done' })).toBe('listening');
  });

  it('leaves state untouched when an event is rejected', () => {
    const machine = new TurnMachine('listening');
    expect(machine.apply({ type: 'audio' })).toBeUndefined();
    expect(machine.state).toBe('listening');
  });

  it('handles consecutive turns', () => {
    const machine = new TurnMachine();
    machine.apply({ type: 'start' });
    for (let i = 0; i < 3; i += 1) {
      expect(machine.apply({ type: 'endpoint' })).toBe('thinking');
      expect(machine.apply({ type: 'audio' })).toBe('speaking');
      expect(machine.apply({ type: 'reply_done' })).toBe('listening');
    }
  });
});
