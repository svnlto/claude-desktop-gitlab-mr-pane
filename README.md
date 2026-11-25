# gitlab-mr-pane

A Claude desktop side pane for the GitLab merge request of the current branch, with a GitLab Duo section. It fills the gap left by the desktop app's pull request monitor, which supports GitHub only.

Everything runs through [`glab`](https://gitlab.com/gitlab-org/cli). The host comes from your `glab` configuration, so it works on gitlab.com, self-managed and Dedicated instances. The mod stores no tokens and no hostnames.

## What it shows

- Header: `!<iid> <title>`, a refresh button, and `source -> target · updated Ns ago`.
- Badges: pipeline state, approvals (`1 of 2`, amber when short), open thread count.
- Pipeline jobs with status and duration. A failed job has `Add to Duo ↗`, which attaches the tail of its log as a context chip.
- Open threads (file:line and comment), each attachable as a context chip.
- GitLab Duo: context chips, a goal field, `Run in plan mode ↗` and `Settings` (model, workflow type, skill).
- A plan card when a run awaits your decision: `Approve ↗` or `Reject with reason…`.
- Recent runs for this session. Select one to reopen it.
- Toasts when a job fails or the pipeline goes green.

The pane polls every 30 seconds. Nothing starts a Duo run until you click `Run in plan mode`.

Commands: `/mr` opens the pane, and `/mr-fix [job]` puts the log tail of a failed job (the first failed one if you give no name) into the chat prompt. The goal is typed in the pane itself.

## How Duo runs behave

Checked against `glab` 1.130.0 and `duo` 10.4.0 on a self-managed instance.

- **Plan mode is enforced by the prompt, not by Duo.** Headless `duo cli run` has no approval gate: given a goal it runs its tools straight away, with or without approval flags. The mod therefore starts every run with a plan-only instruction and parses the numbered plan from the reply. `Approve` resumes the same session (`--existing-session-id`) with "execute the plan"; `Reject` resumes it with your reason and asks for a revised plan only. A model that ignores the plan-only instruction can still act, so treat the plan card as a convention, not a guarantee. The mod never passes `--yes` or `--dangerously-skip-permissions`.
- **Context travels in the goal.** `--ai-context-items` reaches the CLI but the model did not see the items in testing, so attached chips are inlined as `<context>` blocks in the goal.
- **Attached logs are sent to Duo.** Job logs can contain secrets. Check a chip's content before running.
- **Failures** come back as an empty stdout and a long debug log on stderr. The pane shows the line after the last `[error]` entry, for example "GitLab Duo Agent Platform is not available for this namespace or project."

## Requirements

- Claude Code 2.1.287 or later (the desktop app works from 2.1.286). Developed and tested with 2.1.325. Mods do not run in WSL sessions, and `claude -p` runs the hooks but draws nothing.
- `glab` 1.130 or later, authenticated (`glab auth login`) against your instance.
- GitLab 19.2 or later, or 18.11 to 19.1 with beta and experimental features on, with Duo Agent Platform available to the project's namespace.
- The `duo` binary, which `glab` downloads on first use. Set `duo_cli_auto_download` in the `glab` config to skip the prompt, since the pane runs it headless.
- A checkout whose current branch has an open merge request.

## Install

```bash
claude plugin install gitlab-mr-pane --marketplace svnlto/claude-desktop-gitlab-mr-pane
```

In a session: `/plugin install gitlab-mr-pane --marketplace svnlto/claude-desktop-gitlab-mr-pane`, then `/reload-plugins`.

## What the mod runs

Mods are not sandboxed and run with your permissions. Run `claude plugin validate .` to audit this one. Its `calls:` line lists everything it can touch: `$.process.run` (only `glab`: `mr view`, read-only `api` GET requests, and `duo cli run`), `$.state`, `$.clock`, `$.command`, `$.prompt.fill`, `$.ui`. It makes no HTTP requests of its own, reads no files and no environment variables, and holds no credentials; `glab` does the authentication.

## Development

All tooling comes from [devbox](https://www.jetify.com/devbox) with pinned versions, and recipes live in the `justfile`. The `claude` CLI stays outside devbox.

```bash
devbox run -- just test         # Vitest for the pure parsers
devbox run -- just plugin-test  # pane tests through claude plugin test
devbox run -- just typecheck    # tsc
devbox run -- just validate     # claude plugin validate .
```

`just typecheck` needs the engine's API types. The engine writes them to `.claude-plugin/types/` when it loads the mod; otherwise point `CLAUDE_CODE_TYPES` at a `claude-code.d.ts` (the `plugin-authoring` skill ships one) and the recipe copies it in.

Checks are defined once, in `.pre-commit-config.yaml` (local system hooks only: lint, test, validate and plugin-test). They run as the git pre-commit hook, which devbox installs on shell entry (or `just hooks`), and CI runs the same set with `just ci`.

Parsing lives in `hooks/lib/` as pure functions (glab or duo output in, view model out), tested in `test/`. The pane's behaviour is tested in `hooks/register.test.tsx` against canned `glab` and `duo` output.

## Not yet verified

- A run that fails to start because `glab` or `duo` is missing from the machine. The test harness cannot simulate a spawn failure.
- The pane redrawing in the live app after a background refresh. State writes redraw readers by design and `$.ui.invalidate` is called after each refresh, but only the test harness has exercised it.
