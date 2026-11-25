import type { Chip, DuoSettings, RunState } from '../../types'

// Headless `duo run` has no plan checkpoint: it runs tools straight away, with or without
// approval flags. "Plan mode" is therefore a two-phase protocol held in the goal text.
const PLAN_ONLY =
  'PLAN ONLY. Do not create, modify or delete any file and do not run any command that changes state. ' +
  'Reply with a short numbered plan (one step per line, "1. ...") and stop. Wait for approval.'

const APPROVED = 'Plan approved. Execute the plan now.'

const rejected = (reason: string): string =>
  `Plan rejected. Feedback: ${reason}\n\nRevise the plan only. Do not change anything. ` +
  'Reply with a revised numbered plan and wait for approval.'

// `--ai-context-items` reaches the CLI but not the model, so context travels in the goal.
export const contextBlock = (chips: readonly Chip[]): string =>
  chips.map((c) => `<context title="${c.label}">\n${c.content}\n</context>`).join('\n\n')

const base = (s: DuoSettings): string[] => [
  'glab',
  'duo',
  'cli',
  'run',
  '--output-format',
  'json',
  ...(s.model ? ['--model', s.model] : []),
  ...(s.workflowType ? ['--workflow-type', s.workflowType] : []),
  ...(s.skill ? ['--skill', s.skill] : []),
]

export const startArgv = (goal: string, chips: readonly Chip[], s: DuoSettings): string[] => [
  ...base(s),
  '--goal',
  [PLAN_ONLY, `Goal: ${goal}`, contextBlock(chips)].filter(Boolean).join('\n\n'),
]

export type Decision = { approve: true } | { approve: false; reason: string }

export const resumeArgv = (sessionId: string, d: Decision, s: DuoSettings): string[] => [
  ...base(s),
  '--existing-session-id',
  sessionId,
  '--goal',
  d.approve ? APPROVED : rejected(d.reason),
]

export type Phase = 'plan' | 'execute'

export type RunResult = {
  sessionId: string
  state: RunState
  plan: string[]
  text: string
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

export const planSteps = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => /^\s*\d+[.)]\s+(.*\S)\s*$/.exec(l)?.[1])
    .filter((s): s is string => s !== undefined)

// Document schema (duo 10.x, schemaVersion 2.1): { sessionId, exitCode, response, elements, status }.
export const parseRun = (stdout: string, exitCode: number, phase: Phase): RunResult => {
  const doc = (() => {
    try {
      return obj(JSON.parse(stdout.slice(Math.max(0, stdout.indexOf('{')))))
    } catch {
      return {} as Json
    }
  })()
  const status = String(doc.status ?? '').toLowerCase()
  const text = typeof doc.response === 'string' ? doc.response : ''
  const plan = planSteps(text)
  const failed =
    exitCode !== 0 ||
    Object.keys(doc).length === 0 ||
    (doc.exitCode !== undefined && doc.exitCode !== 0) ||
    /fail|error/.test(status)
  const state: RunState = failed
    ? 'failed'
    : phase === 'plan' && plan.length > 0
      ? 'awaiting plan'
      : 'done'
  return { sessionId: doc.sessionId === undefined ? '' : String(doc.sessionId), state, plan, text }
}

// On failure duo prints nothing on stdout and ~30 KB of debug logs on stderr; the cause is the
// line after the last `[error]` entry, e.g. `AgenticChatForbiddenError: <message>`.
export const describeDuoFailure = (stdout: string, stderr: string): string => {
  const lines = stderr.split('\n')
  const at = lines.map((l) => l.includes('[error]')).lastIndexOf(true)
  const cause = at < 0 ? undefined : lines.slice(at, at + 4).find((l) => /\w+Error: /.test(l))
  const named = cause?.replace(/^.*?\w+Error: /, '').trim()
  if (named) return named
  const tail = lines.map((l) => l.trim()).filter(Boolean)
  return stdout.trim() === '' && tail.length === 0 ? 'duo failed' : (tail.at(-1) ?? 'duo failed')
}
