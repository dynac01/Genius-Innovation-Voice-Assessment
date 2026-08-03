#!/usr/bin/env bash
#
# Start the demo and say where it is.
#
# The devcontainer asks Codespaces to open port 5173 in a browser tab, and that is
# a popup — which a browser-based Codespace frequently blocks without saying so.
# The result is a running demo and no visible way in: nothing opens, and the URL
# lives in a PORTS panel that is not obvious if you have not been told about it.
#
# So the URL is printed too. Belt and braces, and the braces cost four lines.
set -euo pipefail

if [[ -n "${CODESPACE_NAME:-}" ]]; then
  domain="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  url="https://${CODESPACE_NAME}-5173.${domain}"

  printf '\n'
  printf '  ┌──────────────────────────────────────────────────────────────┐\n'
  printf '    Voice demo:  %s\n' "$url"
  printf '\n'
  printf '    Open it in a real browser tab. The built-in VS Code preview is\n'
  printf '    a webview and cannot use the microphone, which is the whole\n'
  printf '    demo — it fails silently rather than asking for permission.\n'
  printf '  └──────────────────────────────────────────────────────────────┘\n'
  printf '\n'
fi

exec pnpm dev
