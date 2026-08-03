# Demo runbook and talking points

**For whoever records.** The brief asks for 15–30 minutes in two parts: the working system, then an architectural walkthrough — *"We want to hear your reasoning, not just see the result."*

This is preparation material, not a script. The goal is that nothing about the system is a surprise once the camera is on.

---

## Before you start

```bash
cp .env.example .env          # add DEEPGRAM_API_KEY and ANTHROPIC_API_KEY
# set STT_PROVIDER=deepgram  LLM_PROVIDER=anthropic  TTS_PROVIDER=deepgram
pnpm install && pnpm dev
```

Check the banner says what you expect before recording:

```
[server] pipeline  stt=deepgram  llm=anthropic  tts=deepgram
```

**Use headphones for part 1.** Speakerphone echo is the one untested risk in the project; if the assistant interrupts itself on camera you will spend the demo debugging instead of demonstrating. Show speakerphone deliberately at the end if you want to — as a known limitation, framed as one.

**Warm the connections first.** The first request of a cold process pays ~4 s of TLS setup. Run one throwaway turn before recording, or the opening moment of the demo is the slowest one in it.

---

## Part 1 — the working system

The brief names five things. They have a natural order, and two of them need setting up deliberately or they will not happen on camera.

### 1. A natural back-and-forth

Two or three exchanges. Nothing clever — establish that it works before you start breaking it.

Point at the transcript updating **while you are still speaking**. That is criterion 5's second half and it is easy to miss on video.

### 2. Cutting it off mid-sentence

Ask something that produces a longer answer, then **talk over it about two seconds in**.

Then say the number out loud: **`Barge-in stop` shows real milliseconds**, read off the audio clock. Typically 271 ms against a 300 ms target. This is the criterion weighted hardest — do not let it go by as a detail.

If asked why it is not faster: it was, and the number was dishonest. A 50 ms onset guard buys a headline figure by firing on anything, and a session log showed the cost — a detector reporting 4.3 s of "speech" that a real speech model, on the same microphone, transcribed as nothing. Reference pipelines use a 250 ms minimum-duration guard and credit it with removing 60–80% of false barge-ins. The stop is slower and it is now measuring what it claims to measure.

Do it twice. Once is a demo; twice is a system.

### 3. Resuming an interrupted reply

**This one needs setting up.** The interruption has to land *mid-clause* for the resume to be interesting — interrupt at a sentence boundary and the resume looks like an ordinary continuation.

- Ask something with a long answer
- Interrupt in the **middle of a phrase**
- Say **"keep going"**
- It continues from the word you last heard — not the start, not the next sentence

Say what the alternative would have been: most implementations resume from where the *model* stopped generating, which is several words ahead of what you heard. That gap is the whole point.

Worth also showing **"hold on"** (stays parked and silent) and then **"keep going"** (picks up). Two commands, one parked reply.

### 4. Earcons

Point them out as they happen rather than demonstrating them separately — a faint tone when capture starts, a blip when a request is accepted, a chime when a reply is ready.

The claim worth making: they are mixed on **their own gain node**, so a barge-in ramp cannot silence a failure tone and a chime cannot duck the reply. Non-clobbering is structural, not timed.

### 5. Swapping a pipeline component

Two ways, and the second is stronger:

**Live:** stop the server, set `TTS_PROVIDER=fake-silent`, restart, run a turn. Same transcript, same timings, no sound. Restart with `deepgram` and the voice is back.

**On screen:** `git diff` across the commit that added all three real providers, restricted to the loop —

```bash
git show b397115 --stat -- packages/core/
```

Empty. Three real providers, zero changes to the loop. That is criterion 7 in its strongest form, and it takes ten seconds to show.

### 6. No silent failures — if you want a strong closing beat

The evaluation lists *"no silent failures"* explicitly, and this is the cheapest way
to show it rather than assert it.

Point at the **Speaker output** meter while a reply plays — it is measuring real
samples off the speech node, not reporting a state flag. Then hit **Play test tone**:
it strips out every variable but the last one and says what it measured rather than
what it hopes.

Worth one sentence on why it exists: audio fails without throwing, so a counter that
says "frame delivered" stays green through a muted node, an unplayable rate, or a
decoder that copies nothing. Every one of those happened while building this. The
log records the RMS of the PCM each provider returned, which is what separates "the
synthesiser sent nothing" from "playback lost it" — and that distinction took far
too long to make without it.

### Optional, if it fits

- **Sustained silence** — leave it running and say nothing. No spurious response.
- **Provider hiccup** — harder to stage live; the tests cover it (`pnpm test:feature`) and it may be better as a talking point.

---

## Part 2 — the architectural walkthrough

The brief names six topics. Each has a claim worth leading with, and each has a number or a file behind it.

### Audio streaming design

**Claim:** the browser audio path is thin on purpose — every *decision* is pure logic in `@voice/core`, and the adapter carries none.

- `AudioWorklet` capture → PCM16, not `MediaRecorder`: raw PCM is needed for local VAD, and compressed chunks add latency
- Binary WebSocket frames for audio, JSON for control — no base64 envelope on the highest-volume traffic
- The worklet is plain JS in `public/` rather than TypeScript in `src/`: `addModule` fetches a URL, and routing that through the bundler is a dev-versus-build discrepancy that only shows up in production
- 120 ms jitter buffer — the barge-in tax made explicit

### Barge-in and its latency

**Claim, and lead with it:** the round trip is not in the path.

Detecting an interruption from STT partials spends 200–500 ms before a stop could start travelling back. The budget is gone before anything happens. So the browser decides *that* you spoke and silences locally; the server decides what it **meant**.

Show the budget:

| Stage | ms |
|---|---|
| VAD onset guard | 250 |
| Frame period + dispatch | 8–16 |
| Gain ramp | 12 |
| **Total** | **271** |

Two details worth a sentence each:

- **The ramp, not a cut.** "No audio tail" also means no click; a hard cut at a non-zero sample is its own tail.
- **The jitter buffer never appears.** Buffered audio is discarded, not played out — it costs queue depth, not stop latency.

And the one that separates orderings: **contention is a level, not an edge.** If the user is *already* speaking when the assistant starts, there is no rising edge on user speech, so an edge-triggered barge-in never fires and the assistant talks straight over them. `StartRace` handles both orderings and is exhaustively tested.

### Endpointing and turn-taking

**Claim:** endpointing and barge-in are opposite-biased detectors on the same microphone, so they cannot share tuning.

- Barge-in: 250 ms sustained onset, still biased toward firing relative to endpointing — a late stop is the failure everyone hears, but a false one destroys a reply
- Endpointing: 700 ms trailing silence, biased against firing — cutting someone off mid-thought is worse than a beat of delay

The case that proves it: a partial, a 400 ms gap, then more speech. A detector that failed to re-arm ends the turn at 900 ms — mid-sentence. This one ends it at 1300 ms, 700 ms after the *resumed* speech.

Worth mentioning: the loop arms **one timer** at the endpointer's deadline rather than polling, with a generation counter retiring timers that newer speech superseded. That counter is precisely what stops a stale wake-up ending a turn you are still in.

### The pluggable pipeline and dialog protocol

**Claim:** both seams are load-bearing, and there is evidence rather than assertion.

- **Pipeline:** three real providers, zero changes under `packages/core/`. The loop is written against the interfaces and has no way to *ask* which implementation it got.
- **Dialog:** the model lives behind the protocol, not inside the bridge. The bridge owns everything acoustic and no opinion about what to say.
- Streaming survives the split because the dialog emits `say` **per clause**, not per reply — synthesis of the first clause overlaps generation of the rest.

The pleasing part: `barge_in: "stop" | "pause" | "finish"` turned out to describe the resume semantics exactly. Nothing had to be invented.

### Key tradeoffs

Pick three; the full list is in [the README](../README.md#tradeoffs).

- **Barge-in decided in the browser** — two authorities instead of one, but the budget forbids the alternative
- **Estimated character spans** where the provider reports none — emitting nothing is safe-looking and worse, because resume then replays words you already heard
- **Fakes as the default, real providers opt-in** — CI needs no secrets, a reviewer needs no account, and the fakes force the interfaces to be honest before any SDK shapes them

### What you would change with more time

The README has six, ordered. The first two are the ones to say out loud:

1. **Pre-warm provider connections.** The ~4 s first-request TLS cost lands on the first turn of every cold server. Largest available win, not hard.
2. **Verify the echo guard on a real speakerphone.** The largest untested assumption in the highest-weighted criterion — and worth naming as untested rather than glossed.

---

## Things worth saying that are easy to forget

- **The number is measured, not estimated.** Both endpoints of the barge-in figure are read from the same audio clock — no thread-hop guesswork.
- **The fakes are not test doubles.** They are the harness for every control-flow test, the proof the boundary is real, and the zero-key default. They model *timing*, not just shape: a TTS that returned instantly would make every barge-in test pass trivially, because there would be no window in which to interrupt.
- **The failure modes were designed for, not discovered.** A stalled provider — socket open, nothing sent, nothing thrown — is the one with no error attached, and an idle budget is what turns it into a failed earcon instead of an assistant that appears to have nothing to say.
- **Coverage is honest about its limits.** Mobile tests cover layout, not the engine. iOS `AudioContext` and speakerphone echo are verified by hand, because no desktop browser reproduces them.

---

## Quick reference

```bash
pnpm dev                 # server + web
pnpm test                # 340 unit + feature, ~1s, no keys
pnpm test:e2e            # 16 in a real browser
pnpm bench:latency       # prints the barge-in number

git show b397115 --stat -- packages/core/     # criterion 7: empty
```

| Number | Value |
|---|---|
| Barge-in stop | 271 ms (target < 300) |
| End of turn → first audio, real providers | 1228–2040 ms (target < 2000) |
| Model TTFT, warm | 565–1332 ms |
| TTS TTFB, warm | 416–477 ms |
| Tests | 340 unit + feature, 16 e2e |
