# The claude CLI stays outside devbox; CI overrides it: CLAUDE="pnpm dlx @anthropic-ai/claude-code@<version>"
claude := env_var_or_default('CLAUDE', 'claude')

# Run inside devbox: `devbox run -- just <recipe>` or via direnv.

default:
    @just --list

# The engine writes these types when it loads the mod. Without that, copy them from the
# plugin-authoring skill: CLAUDE_CODE_TYPES=<path to claude-code.d.ts> just types
types:
    @test -n "${CLAUDE_CODE_TYPES:-}" || test -f .claude-plugin/types/claude-code/index.d.ts || { echo "set CLAUDE_CODE_TYPES to claude-code.d.ts" >&2; exit 1; }
    @if [ -n "${CLAUDE_CODE_TYPES:-}" ]; then mkdir -p .claude-plugin/types/claude-code && cp "$CLAUDE_CODE_TYPES" .claude-plugin/types/claude-code/index.d.ts; fi

typecheck: types
    pnpm exec tsc --noEmit -p .

test:
    pnpm exec vitest run

plugin-test:
    {{claude}} plugin test .

lint:
    biome check .

format:
    biome check --write .

validate:
    {{claude}} plugin validate .

# Installs the git pre-commit hook (.pre-commit-config.yaml); devbox does it on shell entry once .git exists.
hooks:
    pre-commit install

# What CI runs.
ci:
    pre-commit run --all-files
