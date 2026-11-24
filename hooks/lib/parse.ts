import type { Job, Mr, Thread } from '../../types'

type Json = Record<string, unknown>

const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export type MrBase = Pick<
  Mr,
  'iid' | 'title' | 'source' | 'target' | 'updatedAt' | 'pipelineId' | 'pipelineStatus'
>

export const toMrBase = (raw: unknown): MrBase | null => {
  const m = obj(raw)
  const iid = num(m.iid)
  if (iid === null) return null
  const pipe = obj(m.head_pipeline ?? m.pipeline)
  return {
    iid,
    title: str(m.title),
    source: str(m.source_branch),
    target: str(m.target_branch),
    updatedAt: Date.parse(str(m.updated_at)) || 0,
    pipelineId: num(pipe.id),
    pipelineStatus: str(pipe.status, 'none'),
  }
}

export const toApprovals = (raw: unknown): { required: number; given: number } => {
  const a = obj(raw)
  const required = num(a.approvals_required) ?? 0
  const left = num(a.approvals_left) ?? 0
  return { required, given: Math.max(0, required - left) }
}

export const toJobs = (raw: unknown): Job[] =>
  arr(raw).map((j) => {
    const o = obj(j)
    const status = str(o.status)
    return {
      id: num(o.id) ?? 0,
      name: str(o.name),
      status,
      durationS: num(o.duration),
      isFailed: status === 'failed' && o.allow_failure !== true,
    }
  })

export const firstLine = (s: string): string => s.trim().split('\n')[0] ?? ''

export const toThreads = (raw: unknown): Thread[] =>
  arr(raw).flatMap((d) => {
    const disc = obj(d)
    const note = obj(arr(disc.notes)[0])
    if (note.resolvable !== true || note.resolved === true) return []
    const pos = obj(note.position)
    return [
      {
        id: str(disc.id),
        path: str(pos.new_path ?? pos.old_path),
        line: num(pos.new_line ?? pos.old_line),
        text: str(note.body).trim(),
      },
    ]
  })

export type PipelineState = 'failed' | 'running' | 'passed' | 'none'

export const pipelineState = (status: string, jobs: readonly Job[]): PipelineState => {
  if (status === 'failed' || jobs.some((j) => j.isFailed)) return 'failed'
  if (['running', 'pending', 'created', 'preparing', 'waiting_for_resource'].includes(status))
    return 'running'
  if (status === 'success') return 'passed'
  return 'none'
}

export type Toast = { text: string }

export const transitions = (prev: Mr | null, next: Mr): string[] => {
  if (!prev || prev.iid !== next.iid) return []
  const was = new Set(prev.jobs.filter((j) => j.isFailed).map((j) => j.id))
  const failed = next.jobs
    .filter((j) => j.isFailed && !was.has(j.id))
    .map((j) => `Job ${j.name} failed`)
  const wasGreen = pipelineState(prev.pipelineStatus, prev.jobs) === 'passed'
  const isGreen = pipelineState(next.pipelineStatus, next.jobs) === 'passed'
  return !wasGreen && isGreen ? [...failed, 'Pipeline passed'] : failed
}

export const relativeTime = (now: number, then: number): string => {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const formatDuration = (s: number | null): string => {
  if (s === null) return ''
  const t = Math.round(s)
  return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${t % 60}s`
}

export const tailLog = (log: string, maxChars = 12000): string => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
  const clean = log.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
  return clean.length <= maxChars ? clean : clean.slice(-maxChars)
}

export const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`

export type GlabFailure = { kind: 'no-mr' | 'error'; message: string }

// glab prints errors as JSON on stdout under --output json, and as a boxed text block on stderr.
export const describeGlabFailure = (stdout: string, stderr: string): GlabFailure => {
  const fromJson = obj(obj(parseJson(stdout)).error).message
  const fromText = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && l !== 'ERROR')
  const message = str(fromJson) || fromText || 'glab failed'
  return { kind: /no open merge request/i.test(message) ? 'no-mr' : 'error', message }
}
