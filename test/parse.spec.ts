import { describe, expect, it } from 'vitest'
import {
  describeGlabFailure,
  firstLine,
  formatDuration,
  pipelineState,
  relativeTime,
  tailLog,
  toApprovals,
  toJobs,
  toMrBase,
  toThreads,
  transitions,
  truncate,
} from '../hooks/lib/parse'
import type { Mr } from '../types'

describe('toMrBase', () => {
  it('maps the API object', () => {
    expect(
      toMrBase({
        iid: 7,
        title: 'Fix',
        source_branch: 'a',
        target_branch: 'main',
        updated_at: '2026-01-01T00:00:00Z',
        head_pipeline: { id: 9, status: 'failed' },
      }),
    ).toMatchObject({
      iid: 7,
      source: 'a',
      target: 'main',
      pipelineId: 9,
      pipelineStatus: 'failed',
    })
  })
  it('rejects non-MR input', () => expect(toMrBase({ message: '404' })).toBeNull())
})

describe('toApprovals', () => {
  it('derives given from left', () =>
    expect(toApprovals({ approvals_required: 2, approvals_left: 1 })).toEqual({
      required: 2,
      given: 1,
    }))
})

describe('toJobs', () => {
  it('flags failed jobs unless allowed to fail', () => {
    const jobs = toJobs([
      { id: 1, name: 'lint', status: 'failed', duration: 12.4 },
      { id: 2, name: 'opt', status: 'failed', allow_failure: true },
    ])
    expect(jobs.map((j) => j.isFailed)).toEqual([true, false])
  })
})

describe('toThreads', () => {
  it('keeps unresolved resolvable threads with position', () => {
    const t = toThreads([
      {
        id: 'a',
        notes: [
          {
            resolvable: true,
            resolved: false,
            body: 'Rename\nmore',
            position: { new_path: 'x.go', new_line: 4 },
          },
        ],
      },
      { id: 'b', notes: [{ resolvable: true, resolved: true, body: 'done' }] },
      { id: 'c', notes: [{ resolvable: false, body: 'system' }] },
    ])
    expect(t).toEqual([{ id: 'a', path: 'x.go', line: 4, text: 'Rename\nmore' }])
  })
})

describe('pipelineState', () => {
  it('maps statuses', () => {
    expect(pipelineState('success', [])).toBe('passed')
    expect(pipelineState('running', [])).toBe('running')
    expect(pipelineState('failed', [])).toBe('failed')
  })
})

const mr = (over: Partial<Mr>): Mr => ({
  iid: 1,
  title: '',
  source: '',
  target: '',
  updatedAt: 0,
  pipelineId: 1,
  pipelineStatus: 'running',
  approvalsRequired: 0,
  approvalsGiven: 0,
  jobs: [],
  threads: [],
  ...over,
})

describe('transitions', () => {
  it('reports new failures and going green once', () => {
    const failed = toJobs([{ id: 1, name: 'lint', status: 'failed' }])
    expect(transitions(mr({}), mr({ jobs: failed, pipelineStatus: 'running' }))).toEqual([
      'Job lint failed',
    ])
    expect(transitions(mr({ jobs: failed }), mr({ jobs: failed }))).toEqual([])
    expect(transitions(mr({}), mr({ pipelineStatus: 'success' }))).toEqual(['Pipeline passed'])
  })
})

describe('formatting', () => {
  it('relative time', () => expect(relativeTime(100_000, 40_000)).toBe('1m ago'))
  it('duration', () => expect(formatDuration(75)).toBe('1m 15s'))
  it('tails and strips ansi', () => expect(tailLog('\u001b[31mabcdef', 3)).toBe('def'))
})

describe('toMrBase edges', () => {
  it('falls back to pipeline and defaults', () => {
    expect(toMrBase({ iid: 1, pipeline: { id: 3, status: 'success' } })).toMatchObject({
      pipelineId: 3,
      pipelineStatus: 'success',
      title: '',
      updatedAt: 0,
    })
  })
  it('has no pipeline status when none exists', () => {
    expect(toMrBase({ iid: 1 })).toMatchObject({ pipelineId: null, pipelineStatus: 'none' })
  })
  it('rejects null and arrays', () => {
    expect(toMrBase(null)).toBeNull()
    expect(toMrBase([])).toBeNull()
  })
})

describe('toApprovals edges', () => {
  it('never goes negative and tolerates garbage', () => {
    expect(toApprovals({ approvals_required: 1, approvals_left: 3 })).toEqual({
      required: 1,
      given: 0,
    })
    expect(toApprovals(null)).toEqual({ required: 0, given: 0 })
  })
})

describe('toJobs edges', () => {
  it('handles non-arrays and missing fields', () => {
    expect(toJobs(null)).toEqual([])
    expect(toJobs({ message: '401' })).toEqual([])
    expect(toJobs([{}])).toEqual([
      { id: 0, name: '', status: '', durationS: null, isFailed: false },
    ])
  })
  it('keeps null duration for queued jobs', () => {
    expect(
      toJobs([{ id: 1, name: 'a', status: 'pending', duration: null }])[0]?.durationS,
    ).toBeNull()
  })
})

describe('toThreads edges', () => {
  it('falls back to old path and line, and allows general threads', () => {
    const t = toThreads([
      {
        id: 'a',
        notes: [{ resolvable: true, body: 'x', position: { old_path: 'o.go', old_line: 2 } }],
      },
      { id: 'b', notes: [{ resolvable: true, body: 'general' }] },
    ])
    expect(t).toEqual([
      { id: 'a', path: 'o.go', line: 2, text: 'x' },
      { id: 'b', path: '', line: null, text: 'general' },
    ])
  })
  it('skips discussions without notes and non-arrays', () => {
    expect(toThreads([{ id: 'a', notes: [] }])).toEqual([])
    expect(toThreads('nope')).toEqual([])
  })
})

describe('pipelineState edges', () => {
  it('a failed job outranks a running pipeline', () => {
    const jobs = toJobs([{ id: 1, name: 'a', status: 'failed' }])
    expect(pipelineState('running', jobs)).toBe('failed')
  })
  it('allowed failures do not fail the pipeline', () => {
    const jobs = toJobs([{ id: 1, name: 'a', status: 'failed', allow_failure: true }])
    expect(pipelineState('success', jobs)).toBe('passed')
  })
  it('treats pending, created and unknown', () => {
    expect(pipelineState('pending', [])).toBe('running')
    expect(pipelineState('created', [])).toBe('running')
    expect(pipelineState('canceled', [])).toBe('none')
    expect(pipelineState('none', [])).toBe('none')
  })
})

describe('transitions edges', () => {
  const failed = toJobs([{ id: 1, name: 'lint', status: 'failed' }])
  it('is silent on first load and on a different MR', () => {
    expect(transitions(null, mr({ jobs: failed }))).toEqual([])
    expect(transitions(mr({ iid: 2 }), mr({ jobs: failed }))).toEqual([])
  })
  it('reports each newly failed job once, plus green', () => {
    const two = toJobs([
      { id: 1, name: 'lint', status: 'failed' },
      { id: 2, name: 'unit', status: 'failed' },
    ])
    expect(transitions(mr({ jobs: failed }), mr({ jobs: two }))).toEqual(['Job unit failed'])
  })
  it('does not repeat green', () => {
    expect(
      transitions(mr({ pipelineStatus: 'success' }), mr({ pipelineStatus: 'success' })),
    ).toEqual([])
  })
  it('a retried job that fails again is a new failure', () => {
    const retried = toJobs([{ id: 3, name: 'lint', status: 'failed' }])
    expect(transitions(mr({ jobs: failed }), mr({ jobs: retried }))).toEqual(['Job lint failed'])
  })
})

describe('formatting edges', () => {
  it('relative time across units and clock skew', () => {
    expect(relativeTime(10_000, 10_000)).toBe('0s ago')
    expect(relativeTime(0, 5_000)).toBe('0s ago')
    expect(relativeTime(3_600_000, 0)).toBe('1h ago')
    expect(relativeTime(2 * 86_400_000, 0)).toBe('2d ago')
    expect(relativeTime(59_000, 0)).toBe('59s ago')
  })
  it('duration', () => {
    expect(formatDuration(null)).toBe('')
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(59.6)).toBe('1m 0s')
    expect(formatDuration(3700)).toBe('61m 40s')
  })
  it('tailLog leaves short logs and strips carriage returns', () => {
    expect(tailLog('a\r\nb')).toBe('a\nb')
    expect(tailLog('x'.repeat(50), 10)).toHaveLength(10)
  })
  it('truncate', () => {
    expect(truncate('abc', 3)).toBe('abc')
    expect(truncate('abcd', 3)).toBe('ab…')
    expect(firstLine('  one\ntwo')).toBe('one')
  })
})

describe('describeGlabFailure', () => {
  it('reads the json error glab prints under --output json', () => {
    expect(describeGlabFailure('{"error":{"message":"401 Unauthorized"}}', 'ERROR')).toEqual({
      kind: 'error',
      message: '401 Unauthorized',
    })
  })
  it('classifies a branch without a merge request as no-mr', () => {
    const f = describeGlabFailure(
      '{"error":{"message":"no open merge request available for \\"topic\\""}}',
      '',
    )
    expect(f.kind).toBe('no-mr')
  })
  it('falls back to the first real line of the boxed stderr text', () => {
    const stderr = '          \n   ERROR  \n          \n  Get "https://gitlab.example/api": EOF.\n'
    expect(describeGlabFailure('', stderr)).toEqual({
      kind: 'error',
      message: 'Get "https://gitlab.example/api": EOF.',
    })
  })
  it('has a message even when glab said nothing', () => {
    expect(describeGlabFailure('', '')).toEqual({ kind: 'error', message: 'glab failed' })
  })
})
