import type { Chip, DuoSettings, RunState } from '../../types'

// Never `--yes`: it would skip the plan checkpoint.
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

export const contextItems = (chips: readonly Chip[]): string =>
  JSON.stringify(
    chips.map((c) => ({
      category: 'snippet',
      id: c.id,
      content: c.content,
      metadata: { title: c.label },
    })),
  )

export const startArgv = (goal: string, chips: readonly Chip[], s: DuoSettings): string[] => [
  ...base(s),
  '--goal',
  goal,
  ...(chips.length ? ['--ai-context-items', contextItems(chips)] : []),
]

export type Decision = { approve: true } | { approve: false; reason: string }

export const resumeArgv = (sessionId: string, d: Decision, s: DuoSettings): string[] => [
  ...base(s),
  '--existing-session-id',
  sessionId,
  '--goal',
  d.approve ? 'Approved. Continue.' : d.reason,
  '--approval',
  d.approve ? 'true' : 'false',
  ...(d.approve ? [] : ['--rejection-reason', d.reason]),
]

export type RunResult = {
  sessionId: string
  state: RunState
  plan: string[]
  text: string
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const pick = (o: Json, keys: readonly string[]): unknown =>
  keys.map((k) => o[k]).find((v) => v !== undefined && v !== null)

const planSteps = (v: unknown): string[] => {
  if (Array.isArray(v))
    return v
      .map((s) =>
        typeof s === 'string'
          ? s
          : String(pick(obj(s), ['description', 'title', 'text', 'step']) ?? ''),
      )
      .filter(Boolean)
  if (typeof v === 'string')
    return v
      .split('\n')
      .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
      .filter(Boolean)
  return []
}

// The json document's schema is unverified: read the likely keys, tolerate absence.
export const parseRun = (stdout: string, exitCode: number): RunResult => {
  const start = stdout.indexOf('{')
  const doc = (() => {
    try {
      return obj(JSON.parse(stdout.slice(Math.max(0, start))))
    } catch {
      return {} as Json
    }
  })()
  const isDocument = Object.keys(doc).length > 0
  const status = String(pick(doc, ['status', 'state', 'workflow_status']) ?? '').toLowerCase()
  const plan = planSteps(pick(doc, ['plan', 'plan_steps', 'steps']))
  const state: RunState =
    /approval|input|paused|plan/.test(status) || (plan.length > 0 && /await|pending/.test(status))
      ? 'awaiting plan'
      : exitCode !== 0 || !isDocument || /fail|error/.test(status)
        ? 'failed'
        : /running|progress/.test(status)
          ? 'running'
          : 'done'
  return {
    sessionId: String(
      pick(doc, ['session_id', 'sessionId', 'workflow_id', 'workflowId', 'id']) ?? '',
    ),
    state,
    plan,
    text: String(pick(doc, ['result', 'output', 'message', 'text']) ?? ''),
  }
}
