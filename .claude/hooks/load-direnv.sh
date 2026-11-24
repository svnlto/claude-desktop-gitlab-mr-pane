#!/usr/bin/env bash
# Exports the direnv (devbox) environment into the session so tools resolve inside devbox.
set -euo pipefail
[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0
command -v direnv >/dev/null || exit 0
direnv allow "$CLAUDE_PROJECT_DIR" >/dev/null 2>&1 || true
direnv export bash >>"$CLAUDE_ENV_FILE"
