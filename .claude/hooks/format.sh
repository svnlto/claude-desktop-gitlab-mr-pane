#!/usr/bin/env bash
# Formats the edited file with Biome (inside devbox); silent for files Biome ignores.
set -uo pipefail
file=$(jq -r '.tool_input.file_path // empty')
case "$file" in
  *.ts | *.tsx | *.json) ;;
  *) exit 0 ;;
esac
cd "$CLAUDE_PROJECT_DIR" || exit 0
devbox run -- biome check --write --no-errors-on-unmatched "$file" >&2 || true
