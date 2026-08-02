# Voice Conversation — Ordered Work Plan

**Status:** Phase 0 complete (one item open: Codespaces verification)
**Last updated:** 2026-08-02
**Companion docs:** [DESIGN.md](DESIGN.md) · [TESTING.md](TESTING.md)

Ordered by dependency, not by importance. Each phase states what it unblocks, which success
criteria it closes, and what "done" means. Criteria numbers refer to
[DESIGN.md §3](DESIGN.md#3-success-criteria-from-the-pdf).

**Budget:** ~5–6 days. Rough allocation at the end (§ Schedule).

---

## Ordering rationale

Two things drive the sequence:

1. **Browser audio is where the unknown-unknowns live**, and the highest-weighted criterion
   (barge-in) depends entirely on the browser audio path. A thin end-to-end vertical slice
   comes early (Phase 2) so an AudioWorklet or iOS Safari surprise surfaces on day 1, not day 5.
2. **The fakes come before the real providers.** They are the proof of the pluggable boundary
   and the harness for every control-flow test. Building against them first means the loop is
   fully exercised before a single API key exists — and it forces the interfaces to be honest.

Real providers land late *on purpose* (Phase 7). If they slip, everything else still works and
still demos.

---

## Phase 0 — Foundations

**Goal:** a repo that a reviewer can clone and run, and that CI can build, before any feature
exists. Doing this last is how the Codespaces requirement becomes a retrofit.

- [x] Initialise git repo, monorepo tooling (pnpm workspaces), root `tsconfig`, linting, formatting
- [x] Package skeleton — separating the reusable core from its drivers:
  - [x] `packages/core` — loop, interfaces, protocol, state machines. **Zero I/O dependencies.**
  - [x] `packages/providers` — real + fake STT / LLM / TTS implementations
  - [x] `apps/server` — transport, session management
  - [x] `apps/web` — browser demo
- [x] Test tiers wired up — see [TESTING.md](TESTING.md):
  - [x] Vitest projects: `unit` (colocated in `src`) and `feature` (`tests/feature`)
  - [x] Playwright for `e2e` (`tests/e2e/*.spec.ts`), kept off the fast feedback path
  - [x] `passWithNoTests: false`, so a broken include glob fails instead of passing silently
  - [x] E2E smoke test proving the harness and the fake media device work **now**, not on day 6
  - [x] Root `tsconfig.json` covering tool configs and `tests/`, which belong to no package
- [x] `.devcontainer/devcontainer.json` — Node version, pnpm, port forwarding, post-create install
- [ ] Verify the repo actually opens and runs in a real GitHub Codespace *(do not defer this)*
- [x] GitHub Actions CI — install, typecheck, lint, test. **No secrets.**
- [x] `.env.example` documenting every key, with the app defaulting to fakes when unset

**Done when:** `pnpm install && pnpm test` passes from a cold clone, in a Codespace, with no
API keys, and CI is green.

---

## Phase 1 — Core contracts and fakes

**Goal:** the fixed contracts exist as code, and the fakes that prove them are first-class.

- [ ] `STT`, `LLM`, `TTS` interfaces transcribed verbatim from the PDF ([DESIGN.md §2.1](DESIGN.md#21-pipeline-interfaces))
- [ ] `FromBridge` / `ToBridge` protocol types transcribed verbatim ([DESIGN.md §2.2](DESIGN.md#22-bridge--dialog-protocol))
- [ ] Shared `Message`, `AudioChunk`, `AudioStream` types
- [ ] **Scripted STT fake** — emits a programmed sequence of partials/finals with controllable
      timing, so a test can express "partial, 400ms gap, more speech"
- [ ] **Canned LLM fake** — streams a known reply token-by-token at a controllable rate
- [ ] **Silent TTS fake** — emits correctly-shaped silent audio chunks at realistic pacing, and
      records exactly which text it was asked to synthesize and when it was stopped
- [ ] A virtual clock so control-flow tests are deterministic and fast (no `sleep`-based tests)
- [ ] **Unit:** the virtual clock and each fake's own timing behaviour — the harness has to be
      trustworthy before anything is measured with it

**Done when:** the fakes are importable, documented, and a test can drive a scripted
conversation through them with no real audio.

---

## Phase 2 — Vertical slice *(risk spike)*

**Goal:** sound goes in one end of the browser and comes out the other, through the server.
Nothing intelligent — this exists purely to kill audio-plumbing risk early.

- [ ] WebSocket transport, single duplex connection, session lifecycle
- [ ] Browser mic capture via **AudioWorklet** → PCM16 @ 16kHz mono
      *(AudioWorklet over MediaRecorder: we need raw PCM for local VAD and streaming STT;
      MediaRecorder gives compressed chunks with added latency)*
- [ ] `getUserMedia` with `echoCancellation`, `noiseSuppression`, `autoGainControl` enabled
- [ ] Mic permission handling — request, denied, and revoked states all handled visibly
- [ ] Browser playback path with an explicit, short jitter buffer (~100–150ms) and a gain node
- [ ] iOS Safari: `AudioContext` created/resumed inside a user gesture
- [ ] Round-trip a fake through the whole path end to end
- [ ] Measure and record baseline round-trip latency

**Done when:** a real browser (desktop **and** a real phone) captures audio, streams it to the
server, and plays server-sent audio back — with the fakes in place.

> **Risk gate.** If AudioWorklet, iOS `AudioContext`, or WebSocket audio framing is going to be
> a problem, it surfaces here. Do not proceed to Phase 3 with this unresolved.

---

## Phase 3 — The loop

**Goal:** the reusable core — streaming both directions, with turn-taking that doesn't talk over
the user or cut them off.

- [ ] Loop orchestrator wiring STT → LLM → TTS, driven entirely through the interfaces
- [ ] Stream LLM output into TTS **incrementally** so speech begins before the reply is complete
      *(sentence/clause chunking so TTS gets natural units, not single tokens)*
- [ ] Stream STT partials to the client so the transcript updates as speech arrives
- [ ] Running transcript of **both** sides, updating incrementally
- [ ] Endpointing: end-of-turn detection tuned for ~600–800ms trailing silence, tolerating
      mid-sentence pauses ([DESIGN.md §4.3](DESIGN.md#43-endpointing-and-barge-in-are-opposite-biased-detectors-on-the-same-mic))
- [ ] Emit `pause_detected` on the bridge protocol
- [ ] Turn state machine: `idle → listening → thinking → speaking → idle`
- [ ] **Unit:** endpoint detector — silence threshold and timing, table-driven
- [ ] **Unit:** clause chunker — LLM token stream → natural TTS units
- [ ] **Unit:** turn state machine — legal transitions, and illegal ones rejected
- [ ] **Feature:** fake STT emits partial → short gap → more speech; assert the assistant waits **(criterion 4)**
- [ ] **Feature:** TTS receives its first chunk before the LLM stream completes **(criterion 5)**
- [ ] **Feature:** transcript updates arrive incrementally, not in one batch at the end **(criterion 5)**
- [ ] Flip the `feature` project to strict once the first test lands *(see [TESTING.md §8](TESTING.md#8-current-state))*

**Done when:** a full conversational turn completes end to end on fakes, and criteria 4 and 5
have passing automated tests.

---

## Phase 4 — Barge-in *(the headline)*

**Goal:** the assistant yields the moment the user speaks. This is the single most heavily
weighted criterion; budget accordingly.

**Fast path — client (target <100ms perceived):**

- [ ] Local VAD on the captured PCM, tuned for ~50ms speech onset
- [ ] On detection: gain ramps to zero over 10–15ms **(a ramp, not a hard cut — no click)**
- [ ] Discard buffered-but-unplayed audio immediately
- [ ] Notify the server of the local interrupt

**Slow path — server (semantics, async):**

- [ ] Bridge emits `interrupt` to the dialog
- [ ] Dialog responds with `barge_in: stop | pause | finish`
- [ ] TTS emission halts **on the next chunk**, not after the current sentence

**Echo suppression:**

- [ ] Adaptive energy threshold on top of browser AEC, so the assistant's own voice does not
      self-interrupt ([DESIGN.md §4.4](DESIGN.md#44-echo--false-barge-in))
- [ ] Verify on a phone with speakerphone on — the worst case, and the one that fails

**Verification:**

- [ ] **Unit:** barge-in onset decision — given an energy envelope, is this speech?
- [ ] **Unit:** echo-gate threshold adaptation
- [ ] **Feature:** an `interrupt` from the bridge stops TTS emission on the next chunk **(criterion 1)**
- [ ] **Latency harness** (`tests/latency/`) — instrument speech onset → assistant audio silent.
      Measured locally and on the deployed URL; **never gated in CI**
      ([TESTING.md §6](TESTING.md#6-latency--measured-never-gated))
- [ ] Commit to a stated target in the README and show the measurement that meets it

**Done when:** cutting the assistant off mid-sentence in a real browser stops it instantly with
no audible tail, criterion 1 has a passing control-flow test, and we have a measured number.

---

## Phase 5 — Resume, pause, cancel + stub dialog

**Goal:** the interruption *means* something. Criterion 2 is the one most submissions will get
subtly wrong.

- [ ] **Text↔audio offset map:** track which characters correspond to which emitted audio chunks
- [ ] **Played-through accounting:** track what actually reached the speaker, not what was
      generated ([DESIGN.md §4.2](DESIGN.md#42-resume-where-it-left-off-is-the-sneaky-one))
- [ ] Resume continues from the played-through offset, mid-sentence if that's where it stopped
- [ ] Stub dialog implementing the fixed protocol, with documented and consistent semantics:
  - [ ] "keep going" / "continue" / "go on" → **resume**
  - [ ] "hold on" / "wait" / "one sec" → **pause**
  - [ ] short backchannels ("mhm", "yeah", "right") → **ignore**, resume automatically
  - [ ] anything else substantive → **fresh turn**, abandon the prior reply
  - [ ] explicit abandon → **cancel**
- [ ] **Unit:** text↔audio offset map — the resume point is the exact last character *heard*.
      The feature test below passes whether the offset is exact or a word off; only this
      pins it ([TESTING.md §2](TESTING.md#2-unit--pure-logic-colocated))
- [ ] **Unit:** utterance classifier — table over all five branches plus ambiguous inputs
- [ ] **Feature:** `barge_in: pause` followed by a resume continues the remaining text **(criterion 2)**
- [ ] **Feature:** new substantive speech abandons the prior reply and it does not resume **(criterion 3)**
- [ ] Document the semantics table in the README

**Done when:** criteria 2 and 3 have passing tests, and resuming an interrupted reply is
audibly correct on camera — it continues, it doesn't restart.

---

## Phase 6 — Earcons

**Goal:** state signalled without words, without ever stepping on speech.

- [ ] Client-side Web Audio synthesis (oscillator-based) on a **separate gain node**, mixed with
      speech — zero network round-trip, and structurally incapable of clobbering the voice
- [ ] Four sounds, each **under half a second**: `listening` (faint tone), `accepted` (soft blip),
      `ready` (gentle chime), `failed` (descending tone)
- [ ] Server sends the `earcon` protocol event; the client renders it
- [ ] Wire each to its actual event — listening on capture start, and the rest on theirs
- [ ] Tune for "non-fatiguing": low volume, short, distinct from each other
- [ ] **Unit:** earcon event selection — which sound for which loop event
- [ ] **Feature:** earcon events are emitted at the right points in the loop **(criterion 6)**

**Done when:** all four fire at the right moments and none cuts off or garbles assistant speech.

---

## Phase 7 — Real providers

**Goal:** swap fakes for real services with **no change to the loop** — which is the proof that
the boundary is real.

- [ ] Deepgram Nova-3 streaming STT behind the `STT` interface
- [ ] Deepgram Aura-2 streaming TTS behind the `TTS` interface
- [ ] Claude Haiku 4.5 behind the `LLM` interface, streaming, with a conversational system prompt
- [ ] Provider selection by env var; fakes remain the zero-key default
- [ ] **Second TTS implementation** (ElevenLabs Flash v2.5) purely to demonstrate the swap
- [ ] **Inspection:** confirm `git diff` reports **zero changes** under `packages/core/` across
      the swap **(criterion 7)**. This is a claim about a diff, not about runtime behaviour, so
      no test can prove it ([TESTING.md §5](TESTING.md#5-criterion-7-is-verified-by-inspection-not-assertion))
- [ ] Re-measure end-to-end round-trip latency against real providers

**Done when:** the same loop runs on real providers and on fakes, selected by configuration, and
the TTS swap is demonstrable live.

---

## Phase 8 — Robustness and awkward cases

**Goal:** criterion 8, plus everything that makes a live demo not embarrassing.

- [ ] Sustained silence produces no spurious response
- [ ] Simultaneous start — deterministic tiebreak, no deadlock, no talking over each other
      ([DESIGN.md §4.5](DESIGN.md#45-simultaneous-start-criterion-8))
- [ ] Provider hiccup mid-reply → `failed` earcon and clean recovery, never a hang
- [ ] Timeouts on every provider call
- [ ] WebSocket disconnect / reconnect handling
- [ ] No silent failures anywhere — every error path surfaces to the user
- [ ] **Unit:** simultaneous-start tiebreak — deterministic for every ordering
- [ ] **Feature:** all three awkward cases **(criterion 8)**

**Done when:** all three awkward cases are covered by tests and behave correctly when triggered
by hand.

---

## Phase 9 — Mobile and deployment

**Goal:** a URL a stranger can open on a phone and talk to.

- [ ] Mobile browser pass — iOS Safari and Android Chrome, both real devices
- [ ] Touch-friendly UI, sensible layout at phone widths
- [ ] Mic permission flow on mobile specifically (different prompt, different failure modes)
- [ ] Dockerfile — single container, no host-specific code
- [ ] Deploy to Fly.io with HTTPS and WebSocket support confirmed
- [ ] Secrets configured on the host, not in the repo
- [ ] **E2E:** full turn on the fakes — permission granted, socket connects, transcript renders
      both sides ([TESTING.md §4](TESTING.md#4-e2e--thin-and-real))
- [ ] **Latency harness** re-run against the deployed URL; record the numbers
- [ ] End-to-end verification on the deployed URL, from a phone, on cellular

**Done when:** the deployed HTTPS URL works end to end on a phone that has never seen the app.

---

## Phase 10 — Documentation and demo

**Goal:** the parts that are actually graded but easy to leave until there's no time left.
Do not compress this.

- [ ] **README:**
  - [ ] Architecture overview with the loop/pipeline/dialog boundaries drawn
  - [ ] Local setup, and Codespaces setup
  - [ ] Which STT / LLM / TTS providers, and how to configure keys
  - [ ] How to run the tests — all four tiers ([TESTING.md](TESTING.md))
  - [ ] **Stated latency targets and the measured numbers we hit** *(explicitly required)*
  - [ ] Resume / pause / cancel semantics table
  - [ ] Tradeoffs weighed, and what would change with more time
- [ ] Rehearse the demo — know which barge-in moments to hit
- [ ] **Record part 1 — the working system:** natural back-and-forth, cutting the assistant off
      mid-sentence and it stopping instantly, resuming an interrupted reply, earcons signalling
      state, and the pipeline component swap
- [ ] **Record part 2 — architectural walkthrough:** audio streaming design, barge-in mechanism
      and its latency, endpointing and turn-taking, the pluggable pipeline and dialog protocol,
      key tradeoffs, and what would change with more time
- [ ] Total 15–30 minutes. *"We want to hear your reasoning, not just see the result."*
- [ ] Final pass over the deliverables checklist in [DESIGN.md §7](DESIGN.md#7-deliverables-checklist)

**Done when:** all three deliverables are submitted.

---

## Schedule

| Day | Phases | Notes |
|---|---|---|
| 1 | 0, 1, 2 | Scaffold, contracts, fakes, vertical slice. Ends with the risk gate cleared. |
| 2 | 3 | The loop: streaming both ways, endpointing, turn state machine. |
| 3 | 4 | Barge-in. Give this a full day — it is weighted first and evaluated hardest. |
| 4 | 5, 6 | Resume semantics + stub dialog, then earcons. |
| 5 | 7, 8 | Real providers and the swap; robustness and awkward cases. |
| 6 | 9, 10 | Mobile, deploy, README, demo recording. |

**Slack:** none. If time is lost, the things to cut are the second TTS provider (Phase 7) and
UI polish (Phase 9) — **not** barge-in tuning, the tests, or the demo recording.

---

## Critical path and risk register

| Risk | Phase | Mitigation |
|---|---|---|
| Browser audio plumbing (AudioWorklet, iOS `AudioContext`, WS framing) sinks the schedule | 2 | Vertical slice on day 1 with an explicit risk gate before proceeding |
| Echo → false barge-in, especially on mobile speakerphone | 4 | Browser AEC + adaptive threshold; test on a real phone, on speaker, early |
| Resume offset accounting is subtly wrong and shows on camera | 5 | Played-through accounting, not generation cursor; short jitter buffer; dedicated test |
| Barge-in latency misses the stated target | 4 | Two-path detection — client kills audio locally, server only handles semantics |
| Real providers slip or misbehave | 7 | Fakes are the default; everything works and demos without keys |
| Demo recording gets compressed into the last hour | 10 | Full day allocated; rehearse before recording |

---

## Criteria coverage map

Every criterion mapped to the phase that closes it, so nothing is discovered missing at the end.

| Criterion | Closed in |
|---|---|
| 1 — Barge-in stops immediately | Phase 4 |
| 2 — Resume an interrupted reply | Phase 5 |
| 3 — Fresh turn after interruption | Phase 5 |
| 4 — Endpointing | Phase 3 |
| 5 — Streaming both ways | Phase 3 |
| 6 — Earcons, non-clobbering | Phase 6 |
| 7 — Pluggable swap | Phase 7 |
| 8 — Graceful awkward cases | Phase 8 |
