#!/usr/bin/env bash
#
# Deploy, then prove it works.
#
# The deploy itself is one command. What this adds is everything either side of
# it: preflight checks that fail with the *cause* rather than a symptom, and a
# verification pass afterwards that exercises the parts a deploy can silently get
# wrong.
#
# The checks exist because each one has a failure mode that surfaces somewhere
# unhelpful. Deploying without secrets does not warn — the server refuses to boot,
# deliberately, and you find out from a health check that never goes green.
# Deploying without an app produces an error about a name rather than about the
# missing `fly launch`. Both are five-second fixes that cost ten minutes to
# diagnose from the other end.
#
# What is *not* here, because it cannot honestly be scripted: `fly auth login`
# opens a browser, and adding a payment method is a web form. Those are named as
# instructions when they are missing rather than pretended into automation.
set -uo pipefail

cd "$(dirname "$0")/.."

fail() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }
step() { printf '\n  → %s\n' "$1"; }
ok()   { printf '    ✓ %s\n' "$1"; }

# ── preflight ─────────────────────────────────────────────────────────────────

command -v fly >/dev/null 2>&1 || fail "flyctl is not installed.
    brew install flyctl"

fly auth whoami >/dev/null 2>&1 || fail "Not signed in to Fly.
    fly auth login
  A payment method is also required — Fly has no free tier."
ok "signed in as $(fly auth whoami 2>/dev/null)"

APP=$(grep -E '^app *=' fly.toml | head -1 | sed 's/.*= *"\(.*\)"/\1/')
[[ -n "$APP" ]] || fail "No app name in fly.toml."

fly status --app "$APP" >/dev/null 2>&1 || fail "App '$APP' does not exist or is not yours.
    fly launch --no-deploy
  The name must be globally unique, so accept the rename it offers."
ok "app '$APP' exists"

# Names and digests only — `fly secrets list` never prints values, and neither
# does this. A missing key is the difference between a deploy that serves the real
# demo and one that refuses to start.
secrets=$(fly secrets list --app "$APP" 2>/dev/null || true)
missing=()
for key in DEEPGRAM_API_KEY ANTHROPIC_API_KEY; do
  grep -q "^$key" <<<"$secrets" || missing+=("$key")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  fail "Missing secrets: ${missing[*]}
    fly secrets set ${missing[*]/%/=...}
  fly.toml asks for real providers, and the server refuses to boot without their
  keys rather than quietly serving fakes to real users. Set them, then re-run."
fi
ok "both provider keys are set"

region=$(grep -E '^primary_region' fly.toml | sed 's/.*= *"\(.*\)"/\1/')
ok "region ${region:-unset} — every turn crosses browser → here → provider"

# ── deploy ────────────────────────────────────────────────────────────────────

step "Deploying"
fly deploy --app "$APP" || fail "Deploy failed. \`fly logs --app $APP\` has the reason."

URL="https://${APP}.fly.dev"

# ── verify ────────────────────────────────────────────────────────────────────
#
# A green deploy means the container started, not that the demo works. These check
# the three things that have actually broken before: the app is served, the
# providers resolved to real rather than silently falling back, and the socket
# upgrades — which is the one a plain health check never touches.

step "Verifying $URL"

for _ in $(seq 1 30); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL/health")" == "200" ]] && break
  sleep 2
done

health=$(curl -s --max-time 10 "$URL/health")
[[ -n "$health" ]] || fail "No response from $URL/health"
ok "health endpoint answers"

grep -q '"stt":"real"' <<<"$health" && grep -q '"llm":"real"' <<<"$health" \
  && grep -q '"tts":"real"' <<<"$health" \
  || fail "Deployed, but running on fakes:
  $health
  That means the keys did not reach the process."
ok "all three providers resolved to real"

page=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL/")
[[ "$page" == "200" ]] || fail "The app itself is not being served (HTTP $page).
  The container serves the built browser app and the socket from one origin, so
  this usually means the web build did not make it into the image."
ok "browser app is served"

# `--max-time` short-circuits a *successful* upgrade, since the connection stays
# open afterwards. 101 is the answer; curl exiting non-zero on timeout is not a
# failure, which is why the status is captured rather than trusted.
upgrade=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$URL/ws" || true)
[[ "$upgrade" == "101" ]] || fail "The WebSocket did not upgrade (got $upgrade).
  HTTPS can be fine while this is broken, and the demo is nothing without it."
ok "WebSocket upgrades over wss"

printf '\n'
printf '  ┌──────────────────────────────────────────────────────────────┐\n'
printf '    Live:  %s\n' "$URL"
printf '\n'
printf '    Always on — no idle timeout, unlike a Codespace. Open it in a\n'
printf '    real browser tab and allow the microphone.\n'
printf '  └──────────────────────────────────────────────────────────────┘\n'
printf '\n'
