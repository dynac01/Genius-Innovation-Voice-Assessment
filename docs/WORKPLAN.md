# Voice Conversation — Ordered Work Plan

**Status:** Phases 0–10 built. All eight success criteria have passing tests. What remains needs a person — see *Not my work*. Barge-in measured at **70–78ms** (target <300ms). Two items need a human: Codespaces, and the phone half of the Phase 2 risk gate.
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

- [x] `STT`, `LLM`, `TTS` interfaces transcribed verbatim from the PDF ([DESIGN.md §2.1](DESIGN.md#21-pipeline-interfaces))
- [x] `FromBridge` / `ToBridge` protocol types transcribed verbatim ([DESIGN.md §2.2](DESIGN.md#22-bridge--dialog-protocol))
- [x] Shared `Message`, `AudioChunk`, `AudioStream` types
- [x] **Scripted STT fake** — emits a programmed sequence of partials/finals with controllable
      timing, so a test can express "partial, 400ms gap, more speech"
- [x] **Canned LLM fake** — streams a known reply token-by-token at a controllable rate
- [x] **Silent TTS fake** — emits correctly-shaped silent audio chunks at realistic pacing, and
      records exactly which text it was asked to synthesize and when it was stopped
- [x] A virtual clock so control-flow tests are deterministic and fast (no `sleep`-based tests)
- [x] **Unit:** the virtual clock and each fake's own timing behaviour — the harness has to be
      trustworthy before anything is measured with it

**Done when:** the fakes are importable, documented, and a test can drive a scripted
conversation through them with no real audio.

---

## Phase 2 — Vertical slice *(risk spike)*

**Goal:** sound goes in one end of the browser and comes out the other, through the server.
Nothing intelligent — this exists purely to kill audio-plumbing risk early.

- [x] WebSocket transport, single duplex connection, session lifecycle
- [x] Browser mic capture via **AudioWorklet** → PCM16 @ 16kHz mono
      *(AudioWorklet over MediaRecorder: we need raw PCM for local VAD and streaming STT;
      MediaRecorder gives compressed chunks with added latency)*
- [x] `getUserMedia` with `echoCancellation`, `noiseSuppression`, `autoGainControl` enabled
- [x] Mic permission handling — request, denied, and revoked states all handled visibly
- [x] Browser playback path with an explicit, short jitter buffer (~100–150ms) and a gain node
- [x] iOS Safari: `AudioContext` created/resumed inside a user gesture
- [x] Round-trip a fake through the whole path end to end
- [ ] Measure and record baseline round-trip latency

**Done when:** a real browser (desktop **and** a real phone) captures audio, streams it to the
server, and plays server-sent audio back — with the fakes in place.

**Desktop half: closed and automated.** `tests/e2e/vertical-slice.spec.ts` drives the round trip
in Chromium against a real `AudioWorklet`, a real socket, and a fake media device — asserting
frames out, transcript in, and assistant audio back. Verified from two cold starts.

**Phone half: open.** iOS Safari's `AudioContext` gesture requirement and playback through a
phone speaker cannot be automated here. The code handles both (context built inside the click
handler, `ToneTts` so playback is audible rather than silent) but neither is *verified*.

> **Risk gate.** If AudioWorklet, iOS `AudioContext`, or WebSocket audio framing is going to be
> a problem, it surfaces here. Do not proceed to Phase 3 with this unresolved.

---

## Phase 3 — The loop

**Goal:** the reusable core — streaming both directions, with turn-taking that doesn't talk over
the user or cut them off.

- [x] Loop orchestrator wiring STT → LLM → TTS, driven entirely through the interfaces
- [x] Stream LLM output into TTS **incrementally** so speech begins before the reply is complete
      *(sentence/clause chunking so TTS gets natural units, not single tokens)*
- [x] Stream STT partials to the client so the transcript updates as speech arrives
- [x] Running transcript of **both** sides, updating incrementally
- [x] Endpointing: end-of-turn detection tuned for ~600–800ms trailing silence, tolerating
      mid-sentence pauses ([DESIGN.md §4.3](DESIGN.md#43-endpointing-and-barge-in-are-opposite-biased-detectors-on-the-same-mic))
- [x] Emit `pause_detected` on the bridge protocol
- [x] Turn state machine: `idle → listening → thinking → speaking → idle`
- [x] **Unit:** endpoint detector — silence threshold and timing, table-driven
- [x] **Unit:** clause chunker — LLM token stream → natural TTS units
- [x] **Unit:** turn state machine — legal transitions, and illegal ones rejected
- [x] **Feature:** fake STT emits partial → short gap → more speech; assert the assistant waits **(criterion 4)**
- [x] **Feature:** TTS receives its first chunk before the LLM stream completes **(criterion 5)**
- [x] **Feature:** transcript updates arrive incrementally, not in one batch at the end **(criterion 5)**

**Done when:** a full conversational turn completes end to end on fakes, and criteria 4 and 5
have passing automated tests.

---

## Phase 4 — Barge-in *(the headline)*

**Goal:** the assistant yields the moment the user speaks. This is the single most heavily
weighted criterion; budget accordingly.

**Fast path — client (target <100ms perceived):**

- [x] Local VAD on the captured PCM, tuned for ~50ms speech onset
- [x] On detection: gain ramps to zero over 10–15ms **(a ramp, not a hard cut — no click)**
- [x] Discard buffered-but-unplayed audio immediately
- [x] Notify the server of the local interrupt

**Slow path — server (semantics, async):**

- [x] Bridge emits `interrupt` to the dialog
- [x] Dialog responds with `barge_in: stop | pause | finish`
- [x] TTS emission halts **on the next chunk**, not after the current sentence

**Echo suppression:**

- [x] Adaptive energy threshold on top of browser AEC, so the assistant's own voice does not
      self-interrupt ([DESIGN.md §4.4](DESIGN.md#44-echo--false-barge-in))
- [ ] Verify on a phone with speakerphone on — the worst case, and the one that fails

**Verification:**

- [x] **Unit:** barge-in onset decision — given an energy envelope, is this speech?
- [x] **Unit:** echo-gate threshold adaptation
- [x] **Feature:** an `interrupt` from the bridge stops TTS emission on the next chunk **(criterion 1)**
- [x] **Latency harness** (`tests/latency/`) — instrument speech onset → assistant audio silent.
      Measured locally and on the deployed URL; **never gated in CI**
      ([TESTING.md §6](TESTING.md#6-latency--measured-never-gated))
- [x] Commit to a stated target in the README and show the measurement that meets it

**Done when:** cutting the assistant off mid-sentence in a real browser stops it instantly with
no audible tail, criterion 1 has a passing control-flow test, and we have a measured number.

**Measured: 70–78ms** across four runs (onset → output silent), against a stated target of
<300ms. Instrument: `pnpm bench:latency`, driving a real Chromium with a WAV stimulus — four
seconds of silence, then a speech-shaped burst timed to land mid-reply. Both endpoints are read
from the same audio clock, so the figure carries no thread-hop guesswork.

Budget, and where the number comes from:

| Stage | ms | Source |
|---|---|---|
| VAD onset evidence | 50 | `DEFAULT_VAD.onsetMs` — configured |
| Frame period + dispatch | ~8–16 | measured |
| Gain ramp to zero | 12 | `STOP_RAMP_MS` — configured |
| **Total** | **70–78** | measured |

The ~120ms jitter buffer never appears: buffered audio is discarded rather than played out,
so it costs queue depth, not stop latency.

**Not yet verified on a phone.** Echo through a phone speaker is the case that breaks this, and
it is a threshold-tuning question (`duckedThresholdDb`), not an architectural one.

---

## Phase 5 — Resume, pause, cancel + stub dialog

**Goal:** the interruption *means* something. Criterion 2 is the one most submissions will get
subtly wrong.

- [x] **Text↔audio offset map:** track which characters correspond to which emitted audio chunks
- [x] **Played-through accounting:** track what actually reached the speaker, not what was
      generated ([DESIGN.md §4.2](DESIGN.md#42-resume-where-it-left-off-is-the-sneaky-one))
- [x] Resume continues from the played-through offset, mid-sentence if that's where it stopped
- [x] Stub dialog implementing the fixed protocol, with documented and consistent semantics:
  - [x] "keep going" / "continue" / "go on" → **resume**
  - [x] "hold on" / "wait" / "one sec" → **pause**
  - [x] short backchannels ("mhm", "yeah", "right") → **ignore**, resume automatically
  - [x] anything else substantive → **fresh turn**, abandon the prior reply
  - [x] explicit abandon → **cancel**
- [x] **Unit:** text↔audio offset map — the resume point is the exact last character *heard*.
      The feature test below passes whether the offset is exact or a word off; only this
      pins it ([TESTING.md §2](TESTING.md#2-unit--pure-logic-colocated))
- [x] **Unit:** utterance classifier — table over all five branches plus ambiguous inputs
- [x] **Feature:** `barge_in: pause` followed by a resume continues the remaining text **(criterion 2)**
- [x] **Feature:** new substantive speech abandons the prior reply and it does not resume **(criterion 3)**
- [ ] Document the semantics table in the README

**Done when:** criteria 2 and 3 have passing tests, and resuming an interrupted reply is
audibly correct on camera — it continues, it doesn't restart.

**Structural change:** the loop split into `AudioBridge` (everything acoustic) and `Dialog`
(everything decided). The model moved *behind* the dialog protocol, where the brief puts it —
`say` commands flow back per clause, so streaming survives the split. A more capable decision
engine now replaces `StubDialog` without `bridge.ts` changing a line.

**Resume semantics** — the table the README needs:

| The user says | Intent | Protocol | Behaviour |
|---|---|---|---|
| "keep going", "go on", "carry on" | `resume` | `barge_in: finish` | Continues from the last character *heard* |
| "mhm", "yeah", "right", "got it" | `backchannel` | `barge_in: finish` | Same — an acknowledgement is not an instruction |
| "hold on", "wait", "one sec" | `pause` | `barge_in: pause` | Reply stays parked; nothing is spoken |
| "stop", "never mind", "that's enough" | `cancel` | `barge_in: stop` | Reply discarded entirely |
| anything substantive | `fresh` | `barge_in: stop` + `say` | Prior reply abandoned; the new utterance drives the next |

A control phrase counts **only as the whole utterance**. "Keep going" resumes; "keep going, but
in Spanish" is a new instruction. Mistaking an instruction for a control word silently drops the
user's request; the reverse costs one redundant reply.

**Pausing stops the voice, not the thinking.** While parked, the dialog keeps generating and the
bridge keeps accumulating text — it simply does not speak it. Resuming is therefore instant
rather than paying generation latency twice, and the resume point is exact because the text was
never discarded.

---

## Phase 6 — Earcons

**Goal:** state signalled without words, without ever stepping on speech.

- [x] Client-side Web Audio synthesis (oscillator-based) on a **separate gain node**, mixed with
      speech — zero network round-trip, and structurally incapable of clobbering the voice
- [x] Four sounds, each **under half a second**: `listening` (faint tone), `accepted` (soft blip),
      `ready` (gentle chime), `failed` (descending tone)
- [x] Server sends the `earcon` protocol event; the client renders it
- [x] Wire each to its actual event — listening on capture start, and the rest on theirs
- [x] Tune for "non-fatiguing": low volume, short, distinct from each other
- [x] **Unit:** earcon event selection — which sound for which loop event
- [x] **Feature:** earcon events are emitted at the right points in the loop **(criterion 6)**

**Done when:** all four fire at the right moments and none cuts off or garbles assistant speech.

**Split:** the *shape* of each sound is data in `packages/core/src/earcons.ts`, asserted against
the brief's requirements — under 500ms, quiet enough to sit under speech, every tone ramped in
and out, all four distinct, failure descending. Only the oscillator wiring lives in the browser,
and it carries no decisions, so the spec cannot drift from what the tests check.

**Non-clobbering is structural, not timed.** Earcons are mixed on their own gain node, parallel
to speech — never through it. A barge-in ramp cannot silence a `failed` tone, and a `ready` chime
cannot duck the reply behind it. There is nothing to tune and nothing to get wrong.

---

## Phase 7 — Real providers

**Goal:** swap fakes for real services with **no change to the loop** — which is the proof that
the boundary is real.

- [x] Deepgram Nova-3 streaming STT behind the `STT` interface
- [x] Deepgram Aura-2 streaming TTS behind the `TTS` interface
- [x] Claude Haiku 4.5 behind the `LLM` interface, streaming, with a conversational system prompt
- [x] Provider selection by env var; fakes remain the zero-key default
- [x] ~~Second TTS implementation (ElevenLabs)~~ — **not needed.** Criterion 7 defines the
      demonstration as "once with a real provider and once with the silent fake", so the swap is
      real ↔ fake. `SilentTts` already exists and is tested; a second paid vendor adds nothing.
- [x] **Inspection:** confirm `git diff` reports **zero changes** under `packages/core/` across
      the swap **(criterion 7)**. This is a claim about a diff, not about runtime behaviour, so
      no test can prove it ([TESTING.md §5](TESTING.md#5-criterion-7-is-verified-by-inspection-not-assertion))
- [x] Re-measure end-to-end round-trip latency against real providers

**Done when:** the same loop runs on real providers and on fakes, selected by configuration, and
the TTS swap is demonstrable live.

**Criterion 7, verified in its strongest form:** adding Deepgram Nova-3, Deepgram Aura-2 and
Claude Haiku 4.5 produced **zero changes under `packages/core/`**. The loop is written against
`STT`, `LLM` and `TTS` and has no way to ask which implementation it was handed.

**Measured against live providers** (warm; the first call of a process pays a one-off ~4s TLS
and connection setup, which is worth pre-warming at session start):

| Stage | Warm | Note |
|---|---|---|
| Claude Haiku 4.5 — time to first token | 565–1332ms | median ≈760ms |
| Deepgram Aura-2 — time to first byte | 416–477ms | |
| Deepgram Nova-3 — socket + stream | connects, streams, closes cleanly | |

**One mapping decision worth recording:** `final` is wired to Deepgram's `speech_final`, **not**
`is_final`. `is_final` means "this text is stable", which is true repeatedly mid-sentence;
`speech_final` means "the speaker stopped". Using the former would end the turn on the first
stable clause — the exact failure criterion 4 exists to catch.

---

## Phase 8 — Robustness and awkward cases

**Goal:** criterion 8, plus everything that makes a live demo not embarrassing.

- [x] Sustained silence produces no spurious response
- [x] Simultaneous start — deterministic tiebreak, no deadlock, no talking over each other
      ([DESIGN.md §4.5](DESIGN.md#45-simultaneous-start-criterion-8))
- [x] Provider hiccup mid-reply → `failed` earcon and clean recovery, never a hang
- [x] Timeouts on every provider call
- [ ] WebSocket disconnect / reconnect handling — *deferred to Phase 9, with deploy*
- [x] No silent failures anywhere — every error path surfaces to the user
- [x] **Unit:** simultaneous-start tiebreak — deterministic for every ordering
- [x] **Feature:** all three awkward cases **(criterion 8)**

**Done when:** all three awkward cases are covered by tests and behave correctly when triggered
by hand.

**Simultaneous start** turned out to be two orderings, not one, and the second is the one an
edge-triggered detector silently misses:

| Ordering | What happens | Caught by |
|---|---|---|
| Assistant speaking, user starts | Rising edge on user speech | edge detection — ordinary barge-in |
| User already speaking, assistant starts | **No edge at all** — the detector latched before the assistant existed | level detection |

So contention is treated as a **level**: the instant both parties claim the turn, whichever way
round they got there, the assistant yields. `StartRace` in `@voice/core` is pure, fires once per
contest (re-yielding every 20ms would stop the assistant ever recovering), and is tested
exhaustively over every three-frame ordering. Deadlock is impossible by construction — yielding
is unilateral, so there is no state where each side waits for the other.

**Provider stalls** are the half of "a provider hiccup" with no error attached: the socket stays
open, nothing throws, and the loop waits forever. `withIdleTimeout` measures the gap *between*
items rather than total duration — a long reply is not a stall, and a wall-clock budget would
kill healthy answers while still missing a provider trickling one byte a minute. Applied to the
real providers only; the fakes are deterministic and a budget there just adds a way for slow CI
to fail.

**A note on what the protocol cannot carry.** A failed provider reaches the user as a `failed`
earcon and the operator as a named log line — `ToBridge` is `say` / `earcon` / `barge_in` and
nothing else, so a dialog has no channel to explain *why*. That is a real constraint rather than
an oversight, and the split is the right one anyway: the user needs "something went wrong", the
operator needs "llm sent nothing for 500ms".

---

## Phase 9 — Mobile and deployment

**Goal:** a URL a stranger can open on a phone and talk to.

- [ ] Mobile browser pass — iOS Safari and Android Chrome, both real devices
- [x] Touch-friendly UI, sensible layout at phone widths
- [x] Mic permission flow on mobile specifically (different prompt, different failure modes)
- [x] Dockerfile — single container, no host-specific code
- [ ] Deploy to Fly.io with HTTPS and WebSocket support confirmed
- [ ] Secrets configured on the host, not in the repo
- [x] **E2E:** full turn on the fakes — permission granted, socket connects, transcript renders
      both sides ([TESTING.md §4](TESTING.md#4-e2e--thin-and-real))
- [ ] **Latency harness** re-run against the deployed URL; record the numbers
- [ ] End-to-end verification on the deployed URL, from a phone, on cellular

**Done when:** the deployed HTTPS URL works end to end on a phone that has never seen the app.

**One container, one origin.** In development Vite serves the app and proxies `/ws`; in
production the server serves both. That is not tidiness — a second origin makes the socket
cross-origin and puts the demo one CORS or cookie policy away from failing on exactly the mobile
browsers it needs to work on. It also means one certificate and one URL to hand over.

Verified locally against the built artefact: the app, its hashed assets, the AudioWorklet, `/ws`
and `/health` all served from `:8787`; SPA routes fall back to `index.html` while a missing
*asset* 404s (HTML for a missing script surfaces as a baffling syntax error); hashed assets cached
immutably and `index.html` never (a deploy must not leave phones on the previous build); and path
traversal — including encoded forms — reaches the fallback or a 404, never a file.

**Reconnect** (deferred here from Phase 8) uses fast-then-backing-off retries: most mobile drops
are momentary — a tunnel, a cell handover, a screen lock — and an immediate retry usually
succeeds, but a genuinely dead server should not be hammered by every phone that ever opened the
page. A deliberate close is distinguished from a dropped one, or ending a session would trigger
the reconnect loop and quietly reopen the microphone.

**Mobile tests cover layout, not the engine.** Chromium at an iPhone viewport asserts no
horizontal overflow, a 44pt-plus touch target, the capability checks above the fold, and a full
turn. WebKit was considered and rejected: it would buy CSS fidelity, but the failures that
actually bite on iOS are in the audio stack, which desktop WebKit does not reproduce either — so
it costs a second browser in CI while leaving the real risk exactly as manual as it already is.

**Still needs a human**, and none of it is automatable from here: the deploy (Fly auth), a real
phone (iOS `AudioContext` gesture, speakerphone echo), and the latency harness re-run against the
deployed URL.

---

## Phase 10 — Documentation

**Goal:** the parts that are graded but easy to leave until there is no time left.

- [x] **README:**
  - [x] Architecture overview with the loop/pipeline/dialog boundaries drawn
  - [x] Local setup, and Codespaces setup
  - [x] Which STT / LLM / TTS providers, and how to configure keys
  - [x] How to run the tests — all four tiers ([TESTING.md](TESTING.md))
  - [x] **Stated latency targets and the measured numbers we hit** *(explicitly required)*
  - [x] Resume / pause / cancel semantics table
  - [x] Tradeoffs weighed, and what would change with more time
- [x] Demo runbook — what to show, in what order, and which moment demonstrates which criterion
- [x] Architecture talking points for the walkthrough, drawn from [DESIGN.md](DESIGN.md)
- [x] Final pass over the deliverables checklist in [DESIGN.md §7](DESIGN.md#7-deliverables-checklist)

**Done when:** the repository is submittable and the demo has everything it needs except a camera.

**Measured for the README** — the brief asks for a stated target and what we hit:

| | Target | Measured |
|---|---|---|
| Barge-in stop | <300ms | **70–78ms** |
| End of turn → first audio, real providers | <2000ms | **1228–2040ms** |

The response figure is at the *edge* of its target rather than comfortably inside it, and the
README says so. The largest single win available is pre-warming provider connections: the first
request of a cold process pays ~4s of TLS setup, which lands on the first turn of every session.

---

## Not my work

This plan tracks building the system. Three things the brief requires are **not** buildable from
here, and listing them as phases was a mis-scope — they were quietly treated as tasks with an
owner when they never had one.

| Deliverable | Why it needs a person | What I can contribute |
|---|---|---|
| **The recorded demo** — both parts | It is a person on camera explaining their own reasoning to an evaluator. That is the deliverable, not a proxy for it. | A runbook and the architecture talking points (Phase 10) |
| **Deploy to a host** | Needs an account and credentials I do not hold | `Dockerfile`, `fly.toml`, and a CI job proving the container boots |
| **Real-device and Codespaces verification** | A physical phone; a Codespace launched from a browser | Every precondition surfaced in the UI; a devcontainer; layout tests at phone size |

The distinction that matters for the demo specifically: everything else on this list is a task I
*cannot execute*. The recording is a task that was never mine. What I can do is make sure that
when the camera starts, nothing about the system is a surprise — which is what the runbook and
talking points are for.

---

## Schedule

| Day | Phases | Notes |
|---|---|---|
| 1 | 0, 1, 2 | Scaffold, contracts, fakes, vertical slice. Ends with the risk gate cleared. |
| 2 | 3 | The loop: streaming both ways, endpointing, turn state machine. |
| 3 | 4 | Barge-in. Give this a full day — it is weighted first and evaluated hardest. |
| 4 | 5, 6 | Resume semantics + stub dialog, then earcons. |
| 5 | 7, 8 | Real providers and the swap; robustness and awkward cases. |
| 6 | 9, 10 | Mobile, deploy, README. Demo recording is yours — see *Not my work*. |

**Slack:** none. If time is lost, the things to cut are the second TTS provider (Phase 7) and
UI polish (Phase 9) — **not** barge-in tuning or the tests. The demo recording is not mine to
cut or to schedule; leave time for it.

---

## Critical path and risk register

| Risk | Phase | Mitigation |
|---|---|---|
| Browser audio plumbing (AudioWorklet, iOS `AudioContext`, WS framing) sinks the schedule | 2 | Vertical slice on day 1 with an explicit risk gate before proceeding |
| Echo → false barge-in, especially on mobile speakerphone | 4 | Browser AEC + adaptive threshold; test on a real phone, on speaker, early |
| Resume offset accounting is subtly wrong and shows on camera | 5 | Played-through accounting, not generation cursor; short jitter buffer; dedicated test |
| Barge-in latency misses the stated target | 4 | Two-path detection — client kills audio locally, server only handles semantics |
| Real providers slip or misbehave | 7 | Fakes are the default; everything works and demos without keys |
| Demo recording gets compressed into the last hour | — | Not my work to schedule. Phase 10 delivers a runbook so the recording needs preparation, not discovery |

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
