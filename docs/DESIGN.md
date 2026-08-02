# Voice Conversation — Design

**Status:** design in progress
**Last updated:** 2026-08-02
**Source:** `assessment-voice-conversation.pdf` (Take-Home Full-Stack Assessment — Voice Conversation)

---

## 1. What is actually being built

A browser-based, hands-free voice assistant. The user starts a session and talks; the
assistant talks back, can be cut off mid-sentence, and plays subtle earcons to signal state.
No phone integration — the microphone is the browser's.

The deliverable being graded is **not the demo**. It is a reusable real-time audio loop with
a pluggable STT → LLM → TTS pipeline, sitting behind a fixed dialog protocol. The PDF is
explicit: *"Think of the loop and its pluggable pipeline as the reusable core; the browser
demo is one way to drive it."*

Time expectation: ~5–6 days with effective use of AI coding tools. Proof of concept, not a
production system. Production polish on audio quality is explicitly **not** expected; a
responsive loop with genuinely good barge-in **is**.

---

## 2. Fixed contracts (cannot be changed)

### 2.1 Pipeline interfaces

```ts
interface STT { transcribeStream(audio: AudioStream): AsyncIterable<{ text: string; final: boolean }>; }
interface LLM { respond(messages: Message[]): AsyncIterable<{ text: string }>; }
interface TTS { synthesizeStream(text: string): AsyncIterable<AudioChunk>; }
```

Each of STT, LLM and TTS must be swappable behind these shapes without touching the loop.

### 2.2 Bridge ↔ dialog protocol

```ts
// Bridge -> dialog
type FromBridge =
  | { type: "utterance"; text: string; t: number }
  | { type: "pause_detected"; t: number }
  | { type: "interrupt"; t: number };          // user started talking over the assistant

// Dialog -> bridge
type ToBridge =
  | { type: "say"; text: string }
  | { type: "earcon"; sound: "listening" | "accepted" | "ready" | "failed" }
  | { type: "barge_in"; behavior: "stop" | "pause" | "finish" };
```

We implement the **bridge side** plus a **simple stub dialog**. The protocol is fixed so a
more capable dialog engine can drop in unchanged.

---

## 3. Success criteria (from the PDF)

Control-flow criteria must be automated against fakes (scripted STT emitting a known
transcript, canned LLM returning a known reply, silent TTS) so they run in CI without live
audio or paid providers. Latency targets must be stated in the README, with evidence we
meet them.

| # | Criterion | Verification |
|---|---|---|
| 1 | **Barge-in stops immediately.** Assistant audio halts within stated target (e.g. <~300ms), no audio tail. | Control flow: an `interrupt` from the bridge stops TTS emission **on the next chunk**, not after the current sentence. |
| 2 | **Resume an interrupted reply.** "Keep going" continues the same reply from where it stopped, not from the start. | Control flow: `barge_in: pause` followed by a resume continues the remaining text. |
| 3 | **Fresh turn after interruption.** Genuinely new user speech abandons the prior reply; the old reply does not resume. | Control flow + live demo. |
| 4 | **Endpointing.** Assistant begins responding within the stated window after the user stops, and does not cut in during a brief mid-sentence pause. | Fake STT emits a partial, a short gap, then more speech — the assistant must wait. |
| 5 | **Streaming both ways.** TTS begins speaking before the full LLM reply exists; transcript updates incrementally from STT partials rather than all at once at the end. | Live demo + tests. |
| 6 | **Earcons at the right moments, non-clobbering.** Listening tone on capture start; accepted / ready / failed on their events. None cut off or garble assistant speech. | Live demo. |
| 7 | **Pluggable swap.** Swapping one pipeline component (e.g. TTS) requires no change to the loop. | Run once with a real provider and once with the silent fake. |
| 8 | **Graceful awkward cases.** Sustained silence causes no spurious response; simultaneous start resolves without deadlock or both talking; a provider hiccup mid-reply surfaces a `failed` earcon rather than hanging. | Live demo + tests. |

### Evaluation weighting (in the PDF's stated order)

1. **Barge-in correctness and latency** — weighted first, "evaluated hardest"
2. Turn-taking and endpointing
3. Pluggable boundaries
4. Audio robustness
5. Transcript clarity
6. Mobile usability
7. End-to-end reliability

> *"The best submissions show real polish and judgment in every detail, above all in how the
> assistant yields the moment the user speaks."*

---

## 4. The hard problems

These are the parts that decide the outcome. The success criteria are written by someone who
knows exactly where naive implementations break.

### 4.1 The latency budget forbids server-side barge-in detection

Target is <~300ms with no audio tail. Detecting barge-in from STT partials server-side spends
200–500ms *before* a stop command starts travelling back to the browser. That budget is gone
before anything happens.

**Therefore: local VAD in the browser must kill playback immediately.** The server round-trip
handles *semantics*, not the stop. Two independent paths:

- **Fast path (client, ~50–100ms):** local VAD detects speech onset → gain ramps to zero over
  10–15ms → buffered audio discarded. A *ramp*, not a hard cut: "no awkward tail" also means
  no click or pop.
- **Slow path (server, async):** the bridge emits `interrupt` to the dialog; the dialog decides
  what the interruption meant and replies with `barge_in: stop | pause | finish`.

### 4.2 "Resume where it left off" is the sneaky one

The LLM streams text → TTS synthesizes ahead → the client buffers audio. The correct resume
point is **the last character the user actually heard**, not where the LLM stopped generating.

This requires a text↔audio offset map and playback-position accounting, and it constrains the
client jitter buffer to stay short (~100–150ms) so the "generated but never played" gap stays
small. Most submissions will resume from the generation cursor, and it will be audibly wrong
on camera.

### 4.3 Endpointing and barge-in are opposite-biased detectors on the same mic

- **End-of-turn** wants ~600–800ms of trailing silence and must tolerate mid-sentence pauses
  (criterion 4 tests exactly this).
- **Barge-in** wants ~50ms of speech onset.

Same signal, two thresholds, opposite failure costs. They cannot share tuning.

### 4.4 Echo → false barge-in

The assistant's own voice leaking into the mic will self-interrupt, especially on mobile
speakers. Needs browser AEC (`echoCancellation: true`) plus an adaptive energy threshold.
Get this wrong and the demo fails on the exact criterion weighted hardest.

### 4.5 Simultaneous start (criterion 8)

Both parties start at the same instant. Needs a deterministic tiebreak or it deadlocks / both
talk over each other.

### 4.6 The fakes are the proof, not the plumbing

The scripted STT / canned LLM / silent TTS are how criteria 1, 2 and 4 get verified without
live audio, and they are the evidence that the pluggable boundary is real. Build them as
first-class citizens, not test doubles bolted on at the end.

---

## 5. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Backend runtime** | TypeScript end-to-end (Node + TS monorepo) | The three pipeline interfaces are specified in TypeScript. A TS monorepo shares the core types verbatim between server and browser — no duplicated contract, no drift. |
| **STT** | Deepgram Nova-3 (streaming) | Streaming with built-in endpointing signals (`speech_final`, `UtteranceEnd`) that feed criterion 4 directly. Cheapest of the realistic options. |
| **LLM** | Claude Haiku 4.5 | Time-to-first-token *is* the product for short conversational replies. Fastest tier. Not a cost compromise — a latency decision. Swappable to Sonnet 5 via config if replies feel thin. |
| **TTS** | Deepgram Aura-2 (streaming) | Purpose-built for low-latency voice agents. Same vendor and key as STT → one key for a reviewer to configure. |
| **Second TTS** | ElevenLabs Flash v2.5 *(optional)* | Makes the criterion-7 pluggable-swap demo concrete against a genuinely different provider. |
| **Deployment** | Fly.io | Persistent WebSockets, HTTPS by default, low RTT. Single Docker container with no host-specific code, so the choice is reversible. |
| **Dev environment** | `.devcontainer/devcontainer.json` | Hard requirement in the PDF. Codespaces forwarded ports are HTTPS → secure context → mic permission works, so the full loop is developable in a Codespace. |
| **Keyless default** | App runs end-to-end on fakes with zero API keys | Reviewer can clone and run instantly; CI needs no secrets; satisfies "self-contained". |

### 5.1 Codespaces vs deployed URL — not the same deliverable

The PDF lists three deliverables, two of which are often conflated:

- **GitHub repository** — "The project must run in GitHub Codespaces." This is about the *repo*
  being runnable in a cloud dev environment. Satisfied by a devcontainer.
- **Deployed URL** — voice demo working end to end over HTTPS, including microphone permission
  handling. A Codespace URL cannot serve this: it is auth-gated by default, stops on idle, and
  dies with the Codespace.

Both are needed. They do not conflict.

---

## 6. Cost analysis

Assumes one minute of live conversation: mic open the whole minute, assistant speaks ~30s
(~750 characters), ~4 turns, context growing to ~1.2k input tokens/turn.

| Layer | Choice | Rate | $/min |
|---|---|---|---|
| STT | Deepgram Nova-3 streaming | $0.0048/min | $0.005 |
| LLM | Claude Haiku 4.5 | $1 / $5 per MTok | $0.007 |
| TTS | Deepgram Aura-2 | $30 / 1M chars | $0.023 |
| | | **Total** | **≈ $0.035/min ≈ $2/hr** |

Swaps, holding everything else fixed:

| Swap | Delta |
|---|---|
| Claude Sonnet 5 instead of Haiku 4.5 | +$0.007/min *(intro $2/$10 per MTok through 2026-08-31, then $3/$15)* |
| Claude Opus 5 instead of Haiku 4.5 | +$0.027/min |
| ElevenLabs Flash v2.5 instead of Aura-2 | +$0.015/min (~$50/1M chars) |
| OpenAI gpt-4o-mini-tts instead of Aura-2 | cheaper per char (~$12–22/1M) but second vendor; streaming TTFB unverified |

**Conclusions:**

- **TTS dominates** — roughly two-thirds of the bill. STT is nearly free; the LLM only matters
  if we go Opus.
- Even the expensive configuration (Opus 5 + ElevenLabs) is ~$4.60/hr. Development, testing and
  the 15–30 minute recorded demo land under $10 total. **Optimize for demo quality, not unit cost.**
- Development costs nothing — the fakes run the whole loop, all tests and CI with zero keys.

### 6.1 One cost/architecture tension worth recording

Streaming STT bills wall-clock, not speech. The obvious saving is to pause the STT socket while
the assistant is talking. **Do not.** That is precisely the window in which barge-in must be
detected. STT stays hot through assistant playback — ~$0.005/min to keep the thing the
assessment grades hardest actually working.

**Sources:** [Deepgram pricing](https://diyai.io/ai-tools/speech-to-text/deepgram-pricing-2026/) ·
[Aura-2 rates](https://texttolab.com/blog/deepgram-pricing) ·
[ElevenLabs pricing](https://elevenlabs.io/pricing) ·
[TTS API cost comparison](https://www.buildmvpfast.com/api-costs/ai-voice)

---

## 7. Deliverables checklist

- [ ] **GitHub repository** with a clear README covering architecture, local setup, which
      STT / LLM / TTS providers were used and how to configure keys, and how to run the tests.
      Must run in GitHub Codespaces.
- [ ] **Deployed URL** with the voice demo working end to end over HTTPS, including microphone
      permission handling.
- [ ] **Recorded demo (15–30 minutes)** in two parts:
  - Part 1 — the working system: natural back-and-forth, cutting the assistant off mid-sentence
    and it stopping instantly, resuming an interrupted reply, earcons signalling state, and if
    feasible swapping one pipeline component.
  - Part 2 — architectural walkthrough: audio streaming design, barge-in mechanism and its
    latency, endpointing and turn-taking approach, the pluggable pipeline and dialog protocol,
    key tradeoffs weighed, and what would change with more time.

Additional quality-bar requirements stated in the PDF:

- [ ] Audio bridge is a standalone module behind the documented dialog protocol.
- [ ] Stub dialog swappable for another implementation without rewriting the loop.
- [ ] Measured round-trip latency target stated **and** what we actually hit.
- [ ] Demo works in mobile browsers as well as desktop, over HTTPS.
- [ ] Tests exercising the pipeline interfaces with fakes to prove loop control flow, the
      barge-in stop, and endpointing decisions — no live audio or paid providers in CI.

---

## 8. Open items

Carried into the architecture pass:

1. **Package layout** — separating the reusable core (loop + interfaces, zero I/O dependencies,
   fully testable) from providers, server and web app.
2. **Barge-in latency budget** — the concrete per-stage numbers for the two-path detection scheme
   in §4.1, and the target we commit to in the README.
3. **Resume-offset mechanism** — how the text↔audio offset map is built and how played-through
   position is accounted for (§4.2).
4. **Bridge ↔ dialog state machine** — states, transitions, and the resume / pause / cancel
   semantics. The PDF requires these be defined and kept consistent: "keep going" resumes,
   "hold on" pauses, the user can abandon a reply entirely.
5. **Transport** — WebSocket framing, audio format, and jitter buffer sizing.
6. **Earcon synthesis** — client-side Web Audio synthesis mixed on a separate gain node, so
   earcons never clobber speech and cost no network round-trip. Server sends the `earcon` event;
   the client renders it.
