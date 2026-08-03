# Voice Conversation

A browser-based, hands-free voice assistant: start a session, talk, and it talks back — and **stops the instant you speak over it**.

The deliverable is not the demo. It is a reusable real-time audio loop with a pluggable STT → LLM → TTS pipeline, sitting behind a fixed dialog protocol. The browser is one way to drive it.

```bash
pnpm install && pnpm dev
```

Then open **http://localhost:5173** and click *Start session*. No API keys, no accounts, no spend — the app runs end to end on fakes by default.

---

## Contents

- [What you'll see](#what-youll-see) · [Architecture](#architecture) · [Latency](#latency-targets-and-what-we-hit)
- [Providers and keys](#providers-and-keys) · [Interruption semantics](#interruption-semantics) · [Testing](#testing)
- [Codespaces](#codespaces) · [Deployment](#deployment) · [Tradeoffs](#tradeoffs) · [With more time](#with-more-time)

---

## What you'll see

Worth setting expectations, because it looks broken otherwise: **on the fake speech-to-text, the transcript is scripted.** Whatever you say, it emits the same words on a timer.

Your microphone *is* genuinely captured, encoded, and streamed — watch `Frames sent` climb. Only the transcription result is canned. Switch **Speech-to-text** to Deepgram in the *Pipeline* controls and it transcribes you for real, from the same session, without restarting anything.

**The part worth actually trying:** wait ~3s for the assistant to start, then talk over it. It stops instantly, `Barge-ins` ticks, and `Barge-in stop` shows the measured milliseconds. That number is real — read off the audio clock, not estimated.

---

## Architecture

```
                        ┌──────────────────── browser ────────────────────┐
                        │                                                 │
   microphone ─▶ AudioWorklet ─▶ VAD ─┬─▶ WebSocket ─────────────┐        │
                        │             │                          │        │
                        │             └─▶ gain ramp → silence    │        │
                        │                 (barge-in, ~70ms)      │        │
                        │                                        │        │
   speaker   ◀── jitter buffer ◀── PCM frames ◀──────────────┐   │        │
                        │      ◀── earcons (own gain node)   │   │        │
                        └────────────────────────────────────┼───┼────────┘
                                                             │   │
                        ┌──────────────────── server ────────┼───┼────────┐
                        │                                    │   ▼        │
                        │   AudioBridge ◀────────────────────┘  audio in  │
                        │      │    ▲                                     │
                        │      │    │  STT ─ endpointer                   │
                        │      │    └───────────────── TTS ───────────────┤
                        │      │                                          │
                        │      ├── FromBridge ──▶ ┌────────┐              │
                        │      │  utterance       │ Dialog │              │
                        │      │  pause_detected  │  (stub)│──▶ LLM       │
                        │      │  interrupt       └────────┘              │
                        │      ◀── ToBridge ── say / earcon / barge_in    │
                        └─────────────────────────────────────────────────┘
```

Three seams, and each is real rather than decorative:

| Seam | Contract | Proof it holds |
|---|---|---|
| **Pipeline** | `STT` / `LLM` / `TTS` | Adding three real providers changed **zero lines** under `packages/core/` |
| **Dialog** | `FromBridge` / `ToBridge` | The model lives behind the protocol; the bridge has no opinion about what to say |
| **Purity** | `@voice/core` does no I/O | `"types": []` in tsconfig plus a lint rule banning `node:*` and provider SDKs — negative-tested |

```
packages/core        the loop, protocol, state machines, VAD, endpointer, chunker — no I/O
packages/providers   fakes first, real providers alongside
apps/server          NestJS host — HTTP, WebSocket gateway, session lifecycle
apps/web             the browser demo
```

**The backend is NestJS, and the loop does not know it.** Modules, DI and lifecycle
live in `apps/server`; turn-taking, endpointing, barge-in arbitration and the dialog
protocol live in `@voice/core`, which imports no Nest, no `node:*` and no provider
SDK — enforced by `"types": []` and a lint rule rather than by discipline. Replacing
a hand-rolled `node:http` server with Nest changed one directory and zero lines of
`packages/core`, which is the same property criterion 7 asks of the providers,
applied to the framework.

Two places where Nest's defaults were the wrong fit and were overridden deliberately:

- **`RawWsAdapter`** disables Nest's message routing. Gateways assume every frame is
  `{ event, data }` JSON; here audio is raw binary at fifty frames a second and
  control is bare JSON from a wire format shared with a browser that has no Nest in
  it. Reshaping the protocol to suit one side's transport layer would be backwards.
- **`StaticMiddleware`** keeps the tested static handler rather than adopting
  `ServeStaticModule`. The existing one carries decisions worth keeping — SPA
  fallback that deliberately does *not* apply to missing assets, rejection of
  malformed percent-encodings and null bytes, hashed assets cached hard while
  `index.html` is not cached at all. Swapping tested behaviour for a module's
  defaults is a downgrade dressed as idiom.

**The bridge owns everything acoustic and no opinion about what to say.** That split is why a real decision engine can replace `StubDialog` without `bridge.ts` changing a line, and why every acoustic behaviour can be tested against a dialog that says exactly what a test needs.

### The fixed contracts

Reproduced exactly as the brief specifies them:

```ts
interface STT { transcribeStream(audio: AudioStream): AsyncIterable<{ text: string; final: boolean }>; }
interface LLM { respond(messages: Message[]): AsyncIterable<{ text: string }>; }
interface TTS { synthesizeStream(text: string): AsyncIterable<AudioChunk>; }

type FromBridge =
  | { type: "utterance"; text: string; t: number }
  | { type: "pause_detected"; t: number }
  | { type: "interrupt"; t: number };

type ToBridge =
  | { type: "say"; text: string }
  | { type: "earcon"; sound: "listening" | "accepted" | "ready" | "failed" }
  | { type: "barge_in"; behavior: "stop" | "pause" | "finish" };
```

One addition worth flagging: `AudioChunk` carries an optional `TextSpan`. The brief fixes the interface *signatures* and leaves `AudioChunk` open, and this is where resume gets won — see [Interruption semantics](#interruption-semantics).

---

## Latency: targets and what we hit

| Measurement | Target | **Measured** | Method |
|---|---|---|---|
| **Barge-in stop** — user speech onset → assistant audio silent | **< 300 ms** | **271 ms** | `pnpm bench:latency`, real Chromium, both endpoints read from the audio clock |
| **Response** — end of turn → first assistant audio *(real providers)* | **< 2000 ms** | **1228–2040 ms** | Server-side probe, warm connections |
| Response *(fakes)* | — | ~550 ms | e2e |
| Model time-to-first-token — Haiku 4.5, warm | — | 565–1332 ms | provider probe |
| TTS time-to-first-byte — Aura-2, warm | — | 416–477 ms | provider probe |

### Where the barge-in number comes from

| Stage | ms | |
|---|---|---|
| VAD onset guard | 250 | configured |
| Frame period + dispatch | 8–16 | measured |
| Gain ramp to zero | 12 | configured |
| **Total** | **271** | **measured** |

The 120 ms jitter buffer never appears in that budget — buffered audio is *discarded*, not played out, so it costs queue depth rather than stop latency.

**Why it's this fast: the round trip is not in the path.** Detecting an interruption from STT partials would spend 200–500 ms before a stop command could even start travelling back. So the browser decides *that* you spoke and silences output locally; the server round trip only decides what it **meant**. Two paths, and only the slow one is allowed to be slow.

The ramp is 12 ms rather than a hard cut because "no audio tail" also means no click — a hard cut at a non-zero sample is its own kind of tail.

### Honest reading of the response number

**1.2–2.0 s is at the edge of the 2 s target**, not comfortably inside it. It decomposes as roughly: model TTFT (0.6–1.3 s) + first speakable clause + TTS TTFB (0.4–0.5 s).

Two things already buy latency there. The clause chunker breaks the **first** chunk early (a finished sentence is never a fragment, however short) so speech starts before the model has finished. And the model and synthesiser run concurrently — serialising them would add most of a second to every turn.

One known, unfixed cost: **the first request of a process pays ~4 s of TLS and connection setup.** That hits the first turn of a cold server and nothing after. Pre-warming provider connections at session start is the obvious fix and is listed under [With more time](#with-more-time).

### Endpointing and detection windows

| Setting | Fakes | Real STT | Why |
|---|---|---|---|
| End-of-turn silence | 700 ms | 2500 ms | With a real STT the provider's own endpointing (`endpointing=800`, `utterance_end_ms=1200`) decides; this is only the backstop for when it never speaks |
| Pause reported | 300 ms | 700 ms | Told to the dialog as information; does **not** end the turn |
| VAD onset | 250 ms | — | Minimum-duration guard. Was 50 ms, which bought a fast headline number by firing on doors, chairs and room tone |
| VAD release | 250 ms | — | Long enough to span the gaps between words |
| Speech threshold | 12 dB over noise floor | — | Adaptive: raises the bar in a noisy room |
| Absolute speech gate | −40 dBFS | — | Floor under the adaptive one. Without it a quiet room drags the threshold down to meet its own ambient tone |
| Threshold while assistant audible | 24 dB | — | Echo guard — see [Tradeoffs](#tradeoffs) |

**Endpointing and barge-in are opposite-biased detectors on the same microphone.** One wants a quarter second of sustained voice and errs toward firing; the other wants most of a second of silence and errs against it. They cannot share tuning, so they do not share code.

---

## Providers and keys

**Switch providers from the UI**, per stage, while the app is running. Each stage has a dropdown; changing one restarts the session with the new pipeline. That is the criterion-7 demonstration in one click rather than a file edit and a server restart.

Everything runs on fakes with **no keys at all**. Keys only decide what the UI is *allowed* to offer — a stage with no key shows its real option greyed out.

```bash
cp .env.example .env      # then fill in the keys you want
```

| Stage | Real | Fake (default) |
|---|---|---|
| STT | Deepgram Nova-3 (streaming) | `ScriptedStt` — programmed partials with controllable timing |
| LLM | Claude Haiku 4.5 (streaming) | `CannedLlm` — known reply, token by token |
| TTS | Deepgram Aura-2 (streaming) | `ToneTts` (audible) / `SilentTts` |

```bash
DEEPGRAM_API_KEY=...       # one key covers STT and TTS
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-haiku-4-5

# Optional: what a session *starts* as. The browser can change any of it.
STT_PROVIDER=deepgram      # fake | deepgram
LLM_PROVIDER=anthropic     # fake | anthropic
TTS_PROVIDER=deepgram      # fake | fake-silent | deepgram
```

**The environment is the default, not the authority.** Two sources ask for providers and they are treated differently: a *browser* request is a user clicking a control, so an unavailable stage clamps to its fake and the UI shows what actually loaded. The *environment* is an operator stating intent at deploy time — asking for a provider whose key is missing **refuses to start**, because falling back silently is how a deployment serves fakes to real users while its health check stays green.

The server prints its default and what it can offer, then logs each session's actual pipeline — a silently-wrong pipeline is worse than a loud failure:

```
[Nest] LOG [bootstrap] default  stt=real  llm=real  tts=real   (real available: stt=true llm=true tts=true)
[Nest] LOG [bootstrap] the browser can change any of these per session
[Nest] LOG [VoiceGateway] [75a1295c] session.hello {"announcedRate":44100,"usingRate":44100,...}
```

**Why Haiku 4.5 is the default:** a latency decision, not a cost one. In a voice loop, time-to-first-token *is* the product — you hear silence until the first clause reaches the synthesiser, so a cleverer answer that starts a second later is usually the worse experience.

The **Model** dropdown offers Haiku 4.5, Sonnet 4.6, Sonnet 5 and Opus 5, switchable mid-session. Every id was verified against the live API before being listed, and the tradeoff is audible: on a short prompt these start speaking roughly 1.4 s, 1.6 s, 1.4 s and 2.5 s in. `ANTHROPIC_MODEL` sets the starting point; the browser overrides it.

The model is a **parameter** of the real provider, not a different implementation — so it travels as its own field (`llmModel`) rather than as more values on `llm`. Folding them together would make swapping a *provider* and picking a *model* look like the same operation, and only the first is criterion 7. The id crosses a trust boundary, so the server treats the shared list in `@voice/core` as a whitelist: anything unrecognised becomes the default rather than a request nobody intended.

**One mapping worth knowing.** Deepgram's `final` is wired to `speech_final`, not `is_final`. `is_final` means "this text is stable" — true repeatedly mid-sentence. `speech_final` means "the speaker stopped." Using the former would end the turn on the first stable clause and cut you off mid-thought.

---

## Interruption semantics

When you interrupt, the browser silences output immediately. The round trip then decides what the interruption *meant* — and the fixed protocol turned out to describe the answer exactly:

| You say | Intent | Protocol | Behaviour |
|---|---|---|---|
| "keep going", "go on", "carry on" | `resume` | `barge_in: finish` | Continues **from the last character you heard** |
| "mhm", "yeah", "right", "got it" | `backchannel` | `barge_in: finish` | Same — acknowledgement is not an instruction |
| "hold on", "wait", "one sec" | `pause` | `barge_in: pause` | Reply stays parked, silent |
| "stop", "never mind", "that's enough" | `cancel` | `barge_in: stop` | Reply discarded |
| anything substantive | `fresh` | `barge_in: stop` + `say` | Prior reply abandoned; the new utterance drives the next |

**A control phrase counts only as the whole utterance.** "Keep going" resumes; *"keep going, but in Spanish"* is a new instruction that happens to start the same way. Mistaking an instruction for a control word silently drops your request; the reverse costs one redundant reply.

### Resume is from what you *heard*

The model runs ahead of the synthesiser, which runs ahead of the playhead. Those are **three different positions**, and resuming from the wrong one is the failure most implementations ship:

```
"It is sunny and mild in Lisbon today, around twenty two degrees. Enjoy it."
 ├───────── heard ─────────┤├──── synthesised ────┤├──── generated ────┤
                           ▲
                    resume from here
```

So `AudioChunk` carries the character span it renders, and the bridge tracks the played-through offset. The test asserts the strong form — `reply.slice(0, from) + remaining === reply` with `from > 0`. Nothing repeated, nothing skipped, no restart.

**Pausing stops the voice, not the thinking.** While parked, the dialog keeps generating and the bridge keeps accumulating text — it simply does not speak it. Resuming is therefore instant rather than paying generation latency twice.

---

## Diagnostics

Audio fails quietly. A muted node, a rate the device will not run, a decoder that
copies nothing — none of them throw, and every counter stays green while the room
is silent. Each of those actually happened here, and each cost a round trip of
guessing because the instruments recorded what the code *intended* rather than what
it *produced*.

So the app measures effect, in three places:

| | What it answers |
|---|---|
| **Speaker output** meter | Is signal reaching the speaker *right now* — sampled from an `AnalyserNode` on the speech gain node, not inferred from state |
| **Play test tone** | Removes every variable but one. A sine through the assistant's own gain node: no provider, no network, no synthesis, no barge-in. Silence here puts the fault below the app — a muted tab, a system output pointed elsewhere |
| **Download logs** | Both sides of the socket in one file — client events, server diagnostics relayed over the wire, engine lifecycle, VAD edges, measured output levels, and the RMS of the PCM each provider returned |

The log is the one that matters for a bug report, and the field that earns its keep
is the least glamorous: `tts.audio { rms, silent }`. "A frame of 960 samples
arrived" is equally true of speech and of silence, so a log full of shapes cannot
tell a synthesiser that returned nothing from a playback path that lost it. One
number does.

Nothing is transmitted anywhere. The button writes a file.

---

## Testing

Four tiers. Full rationale in [docs/TESTING.md](docs/TESTING.md).

```bash
pnpm test              # 340 tests — unit + feature. ~1s, no browser, no keys
pnpm check             # + typecheck, lint, format. What CI runs

pnpm test:e2e:install  # once — downloads Chromium
pnpm test:e2e          # 8 tests in a real browser, incl. phone viewport

pnpm bench:latency     # prints the barge-in number. Never gated in CI
```

| Tier | Runner | Answers |
|---|---|---|
| **Unit** | Vitest, colocated | Is this rule correct? |
| **Feature** | Vitest, `tests/feature` | Does the loop behave? |
| **E2E** | Playwright | Do the seams hold in a real browser? |
| **Latency** | bespoke | How fast is it actually? |

**Every control-flow test runs headless and keyless**, on a virtual clock. A test asserting "the assistant waits through a 400 ms mid-sentence pause" takes microseconds and cannot flake because a CI runner stalled.

**The latency harness is deliberately not in CI.** It is a benchmark producing a number, not a pass/fail assertion; timing on a shared runner is noise, and a flaky gate gets switched off within a day, taking the real signal with it.

### Criteria coverage

| # | Criterion | |
|---|---|---|
| 1 | Barge-in stops immediately | tested + **271 ms measured** |
| 2 | Resume an interrupted reply | tested |
| 3 | Fresh turn after interruption | tested |
| 4 | Endpointing | tested |
| 5 | Streaming both ways | tested |
| 6 | Earcons, non-clobbering | tested |
| 7 | Pluggable swap | **zero core changes** verified |
| 8 | Graceful awkward cases | tested |

---

## Codespaces

Open the repo in a Codespace. The devcontainer installs everything and starts both
halves on attach, so it opens on a running demo rather than on a terminal.

Forwarded ports are HTTPS, which makes the page a **secure context** — and that is
not a detail: `getUserMedia` refuses to run outside one, so this is the reason the
microphone works in a Codespace at all.

**Open port 5173 in a real browser tab**, not VS Code's built-in preview. That
preview is a webview and `getUserMedia` in it is unreliable, which presents as a
microphone that never opens and no clue why. The devcontainer is set to
`openBrowser` for exactly that reason.

One port is enough. The socket is proxied through the same origin as the page, so
`wss://<name>-5173.app.github.dev/ws` works and 8787 never needs publishing — a
second origin would make the socket cross-origin.

Two settings make this work, and both fail in ways that look like something else:

| | Why |
|---|---|
| `server.allowedHosts` | Vite rejects unrecognised `Host` headers as a DNS-rebinding guard. A forwarded port arrives as `<name>-5173.app.github.dev`, so without this **every request 403s, including the page** — which reads as a broken container rather than one config line |
| `hmr.clientPort: 443` | A forwarded URL has no port, so the reload socket would otherwise dial `:5173` on a host that does not publish it. The app still runs; edits just stop refreshing |

CI fakes a Codespaces `Host` header and asserts the page, the API proxy and the
WebSocket upgrade all answer — and that an unknown host is still refused, so an
allow-list that has quietly become allow-everything fails the build.

---

## Deployment

One container serving the built app **and** the WebSocket from a single origin. That is not tidiness: a second origin makes the socket cross-origin and puts the demo one CORS or cookie policy away from failing on exactly the mobile browsers it most needs to work on. It also means one certificate and one URL.

```bash
fly launch --no-deploy          # accept the rename — the app name must be globally unique
fly secrets set DEEPGRAM_API_KEY=... ANTHROPIC_API_KEY=...
fly deploy
```

Secrets go in **before** the first deploy, not after. `fly.toml` asks for real
providers, and asking for a provider whose key is missing makes the server refuse to
boot rather than quietly serve fakes to real users — so deploying without them fails
on purpose, with the reason in `fly logs`.

Then check three things, in this order, because each one only means something if the
previous passed:

```bash
curl https://<app>.fly.dev/health     # pipeline: all three "real"
```

Open the URL on a **phone**, not just a laptop — the criterion says mobile, and iOS
Safari is the one browser nothing else predicts. You should get the microphone
prompt on tapping *Start session*; **decline it once** to check the refusal reads
properly, then allow it and run a turn.

HTTPS is not decoration here: `getUserMedia` refuses to run outside a secure
context, so over plain HTTP the demo does not merely look untidy — the microphone
never opens. `force_https` is set for that reason.

Nothing in the app is host-specific — one container, one port — so another host is a
config change, not a code change. CI builds the image and smoke-tests that the
container boots and serves the app.

> **Not yet deployed.** The deploy needs an account this build does not have.
> `Dockerfile`, `fly.toml`, and a passing container CI job are in the repo; the URL
> is not.

---

## Tradeoffs

**Barge-in is decided in the browser, not the server.** The alternative is one authority instead of two, but the latency budget forbids it — see [above](#where-the-barge-in-number-comes-from). The cost is that the browser can be wrong (echo), which is why the echo guard exists.

**The echo guard raises the bar *and* freezes the noise floor while the assistant talks.** Freezing matters as much as the raised threshold: letting echo drag the floor upward would leave the detector numb for seconds *after* the assistant stops — exactly when you are most likely to speak. Untested on a real speakerphone; that is the largest open risk in the project.

**120 ms jitter buffer.** Shorter means a crisper stop and more dropouts; longer, the reverse. This is the barge-in tax made explicit — nothing already handed to the hardware can be recalled.

**Character spans are estimated where the provider does not report them.** Aura-2 gives no text↔audio mapping. Emitting nothing is the safe-looking choice and the worse one: the loop then resumes at whole-clause granularity, replaying words you already heard. So spans are estimated from a speaking rate and made *safe* rather than accurate — monotonic, clamped, and the final frame pinned exactly. A wrong rate costs precision mid-clause and nothing at its boundaries.

**`tsx` in production rather than a bundled artefact.** Slower cold start, one fewer build step, and production runs the same code path as development. For a proof of concept that is the right side of the trade.

**Idle budgets, not total budgets.** A long reply is not a stall. A wall-clock budget would kill healthy answers while still missing a provider trickling one byte a minute.

**No second real TTS vendor.** Criterion 7 defines the swap as "once with a real provider and once with the silent fake" — real ↔ fake. `SilentTts` already exists and is tested; a second paid vendor adds nothing.

---

## With more time

Roughly in order of what I would do next:

1. **One synthesis socket per reply, flushed once.** Deepgram's TTS WebSocket
   [documents a limit of 20 `Flush` messages per 60 seconds](https://developers.deepgram.com/docs/tts-ws-flush),
   and this sends one `Flush` per *clause* — roughly four per reply. A conversation
   moving faster than a reply every twelve seconds crosses that line, and what
   happens then is not an error: the socket stays open and stops producing audio, so
   it presents as an eight-second stall and a failed earcon. A real session hit it.
   The fix is to send `Speak` per clause on one long-lived socket and `Flush` only
   when the reply ends, which is both fewer flushes *and* lower latency, since audio
   streams continuously instead of restarting per clause. It needs a reply boundary,
   and `synthesizeStream(text)` — fixed by the brief — does not carry one, so it
   wants a small addition to the interface rather than a patch behind it.
2. **A neural VAD in the browser — Silero or a small CNN.** The published stack for
   barge-in is three layers: an absolute energy gate, a *voice classifier* at
   confidence > 0.7, and a 200–300 ms minimum-duration guard. Layers one and three
   are here; the classifier is not, and it is the layer that distinguishes a voice
   from a door. Energy plus duration is a real improvement over energy alone — a
   session log showed the difference starkly — but it still cannot tell a person
   from a fan, and only the classifier can. It means shipping an ONNX runtime and a
   ~2 MB model, which is why it is the next deliberate change rather than a patch.
3. **Pre-warm provider connections at session start.** The ~4 s first-request TLS cost lands on the first turn of every cold server. It is the single largest latency win available and is not hard.
4. **Verify and tune the echo guard on a real speakerphone.** The largest untested assumption in the highest-weighted criterion. If `duckedThresholdDb` is wrong, the assistant interrupts itself — which reads as barge-in working *too* well and is maddening to diagnose.
5. **Adaptive endpointing.** 700 ms is a fixed compromise. Using the STT's own acoustic signals — Deepgram already sends `UtteranceEnd` and VAD events we currently ignore — would let it end faster after a clear stop and wait longer after a trailing conjunction.
6. **Resume across a re-synthesis boundary.** Resume re-synthesises the remaining text, so the voice restarts mid-clause with a fresh prosodic contour. Audible if you listen for it. Splicing at a word boundary would hide it.
7. **A real dialog engine.** The protocol is honoured and the stub is deliberately simple — intent classification is a phrase table. That is the right place to put a model, and the seam is already there.
8. **Per-session provider instances with backpressure.** Each connection currently builds its own pipeline; under load that wants pooling and a queue rather than unbounded sockets.

---

## Documentation

| | |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | Requirements, the hard problems, decisions and why |
| [docs/WORKPLAN.md](docs/WORKPLAN.md) | Phase-by-phase build, with what was measured at each |
| [docs/TESTING.md](docs/TESTING.md) | The four tiers and what each is for |
