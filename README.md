# gitlab-mr-pane

A Claude desktop side pane for the GitLab merge request of the current branch, with a GitLab Duo section. It fills the gap left by the desktop app's pull request monitor, which supports GitHub only.

Everything runs through [`glab`](https://gitlab.com/gitlab-org/cli). The host comes from your `glab` configuration, so it works on gitlab.com, self-managed and Dedicated instances. The mod stores no tokens and no hostnames.

## What it shows

- Header: `!<iid> <title>`, refresh button, `source -> target · updated Ns ago`.
- Badges: pipeline state, approvals (`1 of 2`, amber when short), open thread count.
- Pipeline jobs with status and duration. A failed job has `Add to Duo ↗`, which attaches the job log tail as a context chip.
- Open threads (file:line and comment), each attachable as a context chip.
- GitLab Duo: context chips, a goal field, `Run in plan mode ↗` and `Settings` (model, workflow type, skill).
- A plan checkpoint card when a run awaits approval: `Approve ↗` or `Reject with reason…`.
- Recent runs (this session's runs; select one to reopen it).
- Toasts when a job fails or the pipeline goes green.

The pane polls every 30 seconds. Nothing starts a Duo run until you click, runs never use `--yes`, and the plan approval checkpoint stays on.

## Commands

- `/mr` opens the pane.
- `/mr-fix [job]` puts the log tail of a failed job (the first failed one if no name is given) into the chat prompt.

The pane has a text `Input`, so the goal is typed in the pane. No `/duo` command is needed.

## Prerequisites

- `glab` 1.130 or later, authenticated (`glab auth login`) against your instance.
- GitLab 19.2 or later, or 18.11 to 19.1 with beta and experimental features on.
- The `duo` binary, which `glab` downloads on first use. Set `duo_cli_auto_download` in the `glab` config to skip the prompt, since the pane runs headless.
- A branch with an open merge request, run from a repository checkout.

## Install

```bash
claude plugin install gitlab-mr-pane --marketplace svnlto/claude-desktop-gitlab-mr-pane
```

In a session: `/plugin install gitlab-mr-pane --marketplace svnlto/claude-desktop-gitlab-mr-pane`.

The marketplace is a GitHub repository, which is the documented hosting for `--marketplace svnlto/claude-desktop-gitlab-mr-pane`.

## Development

All tooling comes from [devbox](https://www.jetify.com/devbox); the `claude` CLI stays outside it.

```bash
just test            # Vitest for the pure parsers
just typecheck       # tsc
just validate        # claude plugin validate .
```

`just typecheck` needs the engine's API types. The engine writes them to `.claude-plugin/types/` when it loads the mod; otherwise point `CLAUDE_CODE_TYPES` at a `claude-code.d.ts` (the `plugin-authoring` skill ships one) and the recipe copies it in. `just plugin-test` runs the pane tests through `claude plugin test`.

Checks are defined once, in `.pre-commit-config.yaml` (lint, test, validate, plugin-test). They run as the git pre-commit hook, which devbox installs on shell entry (or `just hooks`), and CI runs the same set with `just ci`.

Parsing lives in `hooks/lib/` as pure functions (glab JSON in, view model out).

## Unverified

- The shape of the `duo cli run --output-format json` document is read tolerantly (`session_id`, `status`, `plan`); confirm against a real run.
- The `--ai-context-items` item shape (`category`, `id`, `content`, `metadata`) is assumed.
- "Plan mode" relies on the approval checkpoint of a headless run, not on a dedicated flag.
