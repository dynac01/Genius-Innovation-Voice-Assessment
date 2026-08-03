#!/usr/bin/env bash
#
# Start the demo in a Codespace, publish it, and say where it is.
#
# Three things happen here that cannot be expressed in devcontainer.json:
#
#   1. Port visibility. `portsAttributes` takes a label and an auto-forward
#      behaviour and nothing else — there is no `visibility` key, whatever it looks
#      like it ought to have. Public forwarding is done with `gh`.
#   2. Using the Codespaces secrets. They arrive as ordinary environment variables,
#      but a *key* is not a decision to spend it, so the server stays on fakes
#      unless something explicitly selects the real providers. Here, in a Codespace
#      where the secrets were deliberately granted to this repository, that
#      selection is warranted. In a local clone it is not, which is why this is
#      guarded rather than baked into the defaults.
#   3. Printing the URL. The auto-open is a popup and browser-based Codespaces
#      block it silently, leaving a running demo with no visible way in.
#
# Deliberately not `set -e`. Publishing the port is a nice-to-have; failing it must
# not take the demo down with it.
set -uo pipefail

# Outside a Codespace this is just `pnpm dev`, so local development is untouched.
if [[ -z "${CODESPACE_NAME:-}" ]]; then
  exec pnpm dev
fi

PORT_WEB=5173
DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
URL="https://${CODESPACE_NAME}-${PORT_WEB}.${DOMAIN}"

# ── use the secrets, if they were granted ──────────────────────────────────────
#
# Each stage independently, because the two keys are granted independently: with
# only Deepgram, speech in and out are real while the reply stays canned. Asking for
# a provider whose key is missing makes the server refuse to boot, so the condition
# is the key's presence rather than a hopeful default.
providers=()
if [[ -n "${DEEPGRAM_API_KEY:-}" ]]; then
  export STT_PROVIDER=deepgram TTS_PROVIDER=deepgram
  providers+=("speech-to-text" "text-to-speech")
fi
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  export LLM_PROVIDER=anthropic
  providers+=("model")
fi

pnpm dev &
dev=$!

# ── publish the port ───────────────────────────────────────────────────────────
#
# After the server is actually listening, not before. A port that Codespaces has
# not forwarded yet cannot be made public, and setting it too early is known to be
# silently undone once forwarding catches up.
published="no"
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://localhost:${PORT_WEB}/" && break
  sleep 1
done
if gh codespace ports visibility "${PORT_WEB}:public" -c "$CODESPACE_NAME" >/dev/null 2>&1; then
  published="yes"
fi

printf '\n'
printf '  ┌────────────────────────────────────────────────────────────────┐\n'
printf '    Voice demo:  %s\n' "$URL"
printf '\n'
if [[ "$published" == "yes" ]]; then
  printf '    Public — send this link to anyone. HTTPS with a real\n'
  printf '    certificate, which is the secure context the microphone\n'
  printf '    needs, so it works for them too. Live while this Codespace\n'
  printf '    is running; stopping the Codespace stops the URL.\n'
else
  printf '    Could not publish the port automatically (this usually means\n'
  printf '    gh lacks the codespace scope). It still works for you, and to\n'
  printf '    share it: PORTS tab, right-click %s, Port Visibility → Public.\n' "$PORT_WEB"
fi
printf '\n'
if [[ ${#providers[@]} -gt 0 ]]; then
  printf '    Codespaces secrets found — real providers on for: %s\n' "${providers[*]}"
else
  printf '    No Codespaces secrets set, so this runs on the fakes: an\n'
  printf '    audible tone rather than a voice. Everything else is real.\n'
fi
printf '\n'
printf '    Open it in a real browser tab. The built-in VS Code preview is\n'
printf '    a webview and cannot use the microphone, which is the whole\n'
printf '    demo — it fails silently rather than asking for permission.\n'
printf '  └────────────────────────────────────────────────────────────────┘\n'
printf '\n'

wait "$dev"
