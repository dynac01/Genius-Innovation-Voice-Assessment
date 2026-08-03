# Voice Conversation — Testing Strategy

**Status:** all four tiers established; unit and feature populated through Phase 3
**Last updated:** 2026-08-02
**Companion docs:** [DESIGN.md](DESIGN.md) · [WORKPLAN.md](WORKPLAN.md)

The brief sets the floor:

> Tests where they are meaningful: at minimum, the pipeline interfaces exercised with fakes
> (a scripted STT, a canned LLM, a silent TTS) to prove the loop's control flow, the barge-in
> stop, and the endpointing decisions without needing live audio or paid providers in CI.

That floor is the **feature** tier below. Three other tiers exist because the floor alone leaves
real gaps — most importantly, a feature test can assert "the reply resumed" while the resume
offset is off by a word.

---

## 1. The four tiers

| Tier | Runner | Location | Gates CI | Answers |
|---|---|---|---|---|
| **Unit** | Vitest (`--project unit`) | `packages/*/src/**/*.test.ts` | yes | Is this rule correct? |
| **Feature** | Vitest (`--project feature`) | `tests/feature/**/*.test.ts` | yes | Does the loop behave? |
| **E2E** | Playwright | `tests/e2e/**/*.spec.ts` | yes (separate job) | Do the seams hold in a real browser? |
| **Latency** | bespoke harness | `tests/latency/` | **no** | How fast is it actually? |

Naming keeps the runners apart: Vitest collects `*.test.ts`, Playwright collects `*.spec.ts`.
Nothing collects both.

```bash
pnpm test            # unit + feature
pnpm test:unit
pnpm test:feature
pnpm test:e2e        # needs: pnpm test:e2e:install (once)
pnpm test:coverage
pnpm check           # typecheck + lint + format + unit + feature
```

---

## 2. Unit — pure logic, colocated

Every subtle rule in the system is a pure function in `@voice/core`, unit-tested in isolation
with a table of cases:

- **Endpoint detector** — trailing-silence threshold and timing
- **Barge-in onset decision** — given an energy envelope, is this speech?
- **Utterance classifier** — resume / pause / backchannel / fresh turn / cancel
- **Text↔audio offset map** — played-through accounting
- **Clause chunker** — LLM stream → natural TTS units
- **Turn state machine** — legal and illegal transitions
- **Simultaneous-start tiebreak**

**Why this tier is not optional.** The criterion-2 feature test asserts that a resumed reply
continues the remaining text. It passes whether the resume point is exact or a word off, because
that is not what it measures. Only a unit test on the offset map pins the exact character. Since
resume-offset accounting is the failure mode most likely to be subtly wrong
([DESIGN.md §4.2](DESIGN.md#42-resume-where-it-left-off-is-the-sneaky-one)), leaving it to the
feature tier means shipping it untested in the way that matters.

The same argument applies to the classifier: one feature test per branch is five slow tests that
say *something* broke. A unit table gives thirty cases and says *which rule* broke.

### The architectural precondition

There is deliberately **no jsdom project**. jsdom does not implement Web Audio, so a test of the
capture or playback path there would be testing a mock of the thing under test.

Instead the boundary is drawn so the question does not arise: **decision logic is pure and lives
in core; the Web Audio adapter in `apps/web` stays thin enough to carry no logic worth
asserting.** "Should we barge in given this energy envelope?" is pure and unit-testable in Node.
"Ramp this `GainNode` to zero over 12ms" is three lines with nothing to get wrong. The adapter's
coverage comes from e2e, in a real browser.

This is the same boundary that lets the loop be driven by something other than a browser, so it
pays for itself twice.

---

## 3. Feature — the loop's control flow, through the fakes

Headless, keyless, deterministic. These drive the real loop with fake providers and assert the
behaviour the brief names. Seven of the eight success criteria close here:

| Criterion | Assertion |
|---|---|
| 1 — barge-in stops | An `interrupt` from the bridge halts TTS emission **on the next chunk**, not after the sentence |
| 2 — resume | `barge_in: pause` then a resume continues the remaining text |
| 3 — fresh turn | New substantive speech abandons the prior reply; it does not resume |
| 4 — endpointing | Partial → short gap → more speech: the assistant waits |
| 5 — streaming | TTS receives chunk one before the LLM stream completes; transcript arrives incrementally |
| 6 — earcons | Events emitted at the right points in the loop |
| 8 — awkward cases | Sustained silence, simultaneous start, provider hiccup mid-reply |

Criterion 7 (pluggable swap) is verified differently — see §5.

### What "fake" means here

Exactly three things are faked, and they are the three pluggable interfaces:

| Fake | Replaces | Behaviour |
|---|---|---|
| Scripted STT | Deepgram Nova-3 | Consumes the real audio stream and ignores it; emits a programmed sequence of `{text, final}` with controllable timing |
| Canned LLM | Claude Haiku 4.5 | Streams a known reply token-by-token at a controllable rate |
| Silent TTS | Deepgram Aura-2 | Emits correctly-shaped **silent** `AudioChunk`s at realistic pacing; records what it was asked to say and when it was stopped |

Nothing else is faked. In fake mode the audio still flows through the entire real path — real
mic, real capture, real WebSocket frames, real jitter buffer, real gain node, real playback. The
audio is silent and the transcript is scripted; every piece of plumbing it passes through is
production code.

The **stub dialog is not a fake.** The brief asks for it as a deliverable ("Implement the bridge
side and a simple stub dialog"). It is the real thing, just simple, and it is what a more capable
dialog engine replaces. Fakes sit at the provider boundary; the stub sits at the dialog boundary.

### The fakes model timing, not just shape

This is the property that makes the tier work. A silent TTS returning all its chunks instantly
would make every barge-in test pass trivially — there would be no window in which to interrupt.
So the fakes emit at realistic pacing, and the scripted STT can express "partial, 400ms gap, more
speech" precisely, because that *is* criterion 4.

They are driven by a **virtual clock**, so tests are deterministic and fast. No `sleep`, no
flake, no multi-second suite.

---

## 4. E2E — thin, and real

Playwright, Chromium, the actual app. The microphone is faked at the *browser* level rather than
mocked in application code: `--use-fake-device-for-media-stream` feeds a WAV to `getUserMedia`,
so the capture path under test is the real one.

**Scope is deliberately narrow** — the seams, not the behaviour:

- Page loads, no console errors
- Secure context, `getUserMedia`, and `AudioWorklet` all available
- Mic permission granted and capture starts
- WebSocket connects
- One full turn completes on the fakes
- Transcript renders both sides

It asserts **nothing** about audio quality or timing. Audio e2e assertions are where flakiness
lives, and a flaky gate gets disabled within a day — taking the real signal with it. The numbers
that matter come from §6 instead, and the recorded demo is the end-to-end evidence the brief
actually asks for.

The Phase 0 smoke test already exists and passes. It landed early on purpose, for the same reason
the vertical slice does: discovering that the Playwright harness, the fake media device, or the
dev-server wiring is broken is cheap on day one and expensive on day six.

---

## 5. Criterion 7 is verified by inspection, not assertion

"Swapping one pipeline component requires no change to the loop" is a claim about a **diff**, not
about runtime behaviour. A passing test proves the swapped provider works; it cannot prove the
loop was untouched.

So it is checked directly: swap the TTS provider, then confirm `git diff` reports zero changes
under `packages/core/`. Automatable as a CI guard later; a documented manual step for now.

Two structural defences back it up, so the property is enforced rather than merely observed:

- `packages/core/tsconfig.json` sets `"types": []` — Node's globals are not in scope
- An ESLint rule bans `node:*` and provider SDKs inside `packages/core`

Both are negative-tested: a file importing `node:fs` into core is rejected by lint.

---

## 6. Latency — measured, never gated

The brief requires a **stated target and the measured number**. That is a benchmark producing a
value, not a pass/fail assertion, and it does not belong in CI: timing on shared runners is noise,
and a flaky latency gate gets switched off, taking the signal with it.

Measured locally and against the deployed URL, recorded in the README:

| Measurement | Target | Method |
|---|---|---|
| Barge-in stop (user speech onset → assistant audio silent) | <~300ms, no tail | Client-side timestamps around the gain ramp |
| End-of-turn → first assistant audio | stated in README | Timestamps across the loop |
| STT partial → transcript update | stated in README | Client render timestamps |

Barge-in latency is the one number the brief singles out, and it is **only** meaningful in a real
browser. The feature tier proves the *control flow* — that an `interrupt` stops emission on the
next chunk. It cannot tell you whether a human hears silence within 300ms. Both are required;
neither substitutes for the other.

---

## 7. Conventions

- **Colocate unit tests** with their source; keep feature and e2e suites separate from `src`.
- **Name the behaviour, not the function**: `waits through a mid-sentence pause`, not `test endpointer`.
- **Table-driven** for anything with more than three cases.
- **No `sleep`.** The virtual clock exists so timing is asserted, not awaited.
- **A run that collects zero tests is a failure** (`passWithNoTests: false`), so a broken include
  glob surfaces immediately instead of silently passing.
- **Coverage is reported for `packages/core` and `packages/providers` only.** Transport adapters
  and the browser shell are covered by e2e; counting their lines would measure the wrong thing.
  No coverage threshold is enforced — a number that can be gamed by testing getters is not the
  goal.

---

## 8. Current state

| Tier | Status |
|---|---|
| Unit | 122 passing — clock, audio, wire codec, queue, turn machine, endpointer, chunker, fakes |
| Feature | 14 passing — scripted conversation, plus the loop's control flow (criteria 4 and 5) |
| E2E | 1 passing — browser preconditions, no console errors |
| Latency | harness lands in Phase 4 |

The unit tier covers the harness itself first: the virtual clock's ordering
guarantees, and each fake's timing behaviour. A timing assertion is only worth as
much as the clock underneath it, so `clock.test.ts` pins the awkward cases — timers
scheduled by timers mid-advance, tie-breaking by registration order, and ordering
held through a 12-deep async generator chain.

CI runs typecheck, lint, format, unit and feature in one job, and e2e in a second so a browser
download never sits on the critical path of the fast feedback loop. Neither job uses a secret.
