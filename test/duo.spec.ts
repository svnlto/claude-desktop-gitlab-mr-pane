import { describe, expect, it } from 'vitest'
import {
  contextBlock,
  describeDuoFailure,
  parseRun,
  planSteps,
  resumeArgv,
  startArgv,
} from '../hooks/lib/duo'

const s = { model: 'm', workflowType: '', skill: '' }
const all = { model: 'claude_sonnet_5_5', workflowType: 'chat', skill: 'review' }
const chip = { id: 'job-1', label: 'lint job log', content: 'boom' }

// Real document shape from duo 10.x (schemaVersion 2.1).
const doc = (response: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: '2.1',
    sessionId: '2717',
    exitCode: 0,
    response,
    elements: [{ type: 'message', role: 'assistant', content: response, isComplete: true }],
    status: 'success',
    ...over,
  })

const goalOf = (argv: readonly string[]) => argv[argv.indexOf('--goal') + 1] ?? ''

describe('startArgv', () => {
  it('runs headless json from glab and never passes a skip-approval flag', () => {
    const a = startArgv('go', [chip], s)
    expect(a.slice(0, 6)).toEqual(['glab', 'duo', 'cli', 'run', '--output-format', 'json'])
    expect(a).toContain('--model')
    for (const bad of ['--yes', '-y', '--dangerously-skip-permissions']) {
      expect(a).not.toContain(bad)
    }
  })
  it('keeps the goal as one argv entry, after the plan-only instruction', () => {
    const goal = `fix "this" && rm -rf /`
    const g = goalOf(startArgv(goal, [], s))
    expect(g.startsWith('PLAN ONLY.')).toBe(true)
    expect(g).toContain(`Goal: ${goal}`)
  })
  it('puts context in the goal, not in --ai-context-items', () => {
    const a = startArgv('go', [chip], s)
    expect(a).not.toContain('--ai-context-items')
    expect(goalOf(a)).toContain('<context title="lint job log">\nboom\n</context>')
  })
  it('passes every setting when present', () => {
    expect(startArgv('go', [], all)).toEqual(
      expect.arrayContaining([
        '--model',
        'claude_sonnet_5_5',
        '--workflow-type',
        'chat',
        '--skill',
        'review',
      ]),
    )
  })
  it('omits empty settings', () => {
    const a = startArgv('go', [], { model: '', workflowType: '', skill: '' })
    expect(a).not.toContain('--model')
    expect(a).not.toContain('--skill')
  })
})

describe('contextBlock', () => {
  it('is empty for no chips and separates several', () => {
    expect(contextBlock([])).toBe('')
    expect(contextBlock([chip, { ...chip, id: '2', label: 'b' }]).split('</context>').length).toBe(
      3,
    )
  })
})

describe('resumeArgv', () => {
  it('approval resumes the session and tells Duo to execute', () => {
    const a = resumeArgv('S1', { approve: true }, all)
    expect(a[a.indexOf('--existing-session-id') + 1]).toBe('S1')
    expect(goalOf(a)).toBe('Plan approved. Execute the plan now.')
    expect(a).toContain('--model')
  })
  it('rejection sends the reason and asks for a revised plan only', () => {
    const g = goalOf(resumeArgv('S1', { approve: false, reason: 'too broad' }, s))
    expect(g).toContain('Feedback: too broad')
    expect(g).toContain('Do not change anything')
  })
  it('never uses the tool-approval flags or a skip flag', () => {
    for (const d of [{ approve: true as const }, { approve: false as const, reason: 'r' }]) {
      const a = resumeArgv('S', d, s)
      for (const bad of [
        '--yes',
        '-y',
        '--approval',
        '--rejection-reason',
        '--dangerously-skip-permissions',
      ]) {
        expect(a).not.toContain(bad)
      }
    }
  })
})

describe('planSteps', () => {
  it('reads numbered lines with . or ) and ignores prose', () => {
    expect(planSteps('Plan:\n1. Edit a.go\n 2) Run `tests`\n\nI will wait.')).toEqual([
      'Edit a.go',
      'Run `tests`',
    ])
  })
  it('is empty without a numbered list', () => expect(planSteps('Just ok')).toEqual([]))
})

describe('parseRun', () => {
  it('a plan-phase answer with numbered steps awaits approval', () => {
    const r = parseRun(doc('Plan:\n1. Create file\n2. Verify\nWaiting for approval.'), 0, 'plan')
    expect(r).toMatchObject({
      sessionId: '2717',
      state: 'awaiting plan',
      plan: ['Create file', 'Verify'],
    })
  })
  it('a plan-phase answer without steps is simply done', () => {
    expect(parseRun(doc('ok'), 0, 'plan')).toMatchObject({ state: 'done', text: 'ok', plan: [] })
  })
  it('an execute-phase answer is done even when it lists numbered steps', () => {
    expect(parseRun(doc('Done:\n1. made it'), 0, 'execute').state).toBe('done')
  })
  it('skips log noise before the document', () => {
    expect(parseRun(`downloading duo...\n${doc('ok')}`, 0, 'plan').sessionId).toBe('2717')
  })
  it('numeric session ids become strings', () => {
    expect(
      parseRun(JSON.stringify({ sessionId: 2718, status: 'success' }), 0, 'plan').sessionId,
    ).toBe('2718')
  })
  it('failure: non-zero process exit, empty or garbled stdout, error status or document exit code', () => {
    expect(parseRun(doc('ok'), 1, 'plan').state).toBe('failed')
    expect(parseRun('', 1, 'plan').state).toBe('failed')
    expect(parseRun('{broken', 0, 'plan').state).toBe('failed')
    expect(parseRun(doc('x', { status: 'error' }), 0, 'plan').state).toBe('failed')
    expect(parseRun(doc('x', { exitCode: 2 }), 0, 'plan').state).toBe('failed')
  })
  it('a failed run yields no session id and no plan', () => {
    expect(parseRun('', 1, 'plan')).toMatchObject({ sessionId: '', plan: [], text: '' })
  })
})

const NOISE = '2026-11-25T08:45:45:983 [debug]: fetch: https agent with options initialized'
const FORBIDDEN = [
  NOISE,
  '2026-11-25T08:45:49:892 [warning]: [Duo Workflow Runner] Failed to read server capabilities',
  '    Error: Error querying AI flows metadata: Error: GraphQL request failed',
  '2026-11-25T08:45:50:873 [error]: [WorkflowRailsService] Failed to create the workflow',
  '    AgenticChatForbiddenError: GitLab Duo Agent Platform is not available for this namespace or project.',
  '2026-11-25T08:45:51:179 [info]: [CliExitHandler] Shutdown complete, good bye :)',
].join('\n')

describe('describeDuoFailure', () => {
  it('names the error after the last [error] entry, not the debug noise', () => {
    expect(describeDuoFailure('', FORBIDDEN)).toBe(
      'GitLab Duo Agent Platform is not available for this namespace or project.',
    )
  })
  it('ignores earlier warning Errors', () => {
    expect(describeDuoFailure('', FORBIDDEN)).not.toContain('AI flows metadata')
  })
  it('falls back to the last stderr line without an [error] entry', () => {
    expect(describeDuoFailure('', 'a\n\nglab: duo not installed\n')).toBe('glab: duo not installed')
  })
  it('has a message when both streams are empty', () => {
    expect(describeDuoFailure('', '')).toBe('duo failed')
  })
})
