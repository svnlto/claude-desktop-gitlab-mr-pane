import { describe, expect, it } from 'vitest'
import { contextItems, parseRun, resumeArgv, startArgv } from '../hooks/lib/duo'

const s = { model: 'm', workflowType: '', skill: '' }

describe('argv', () => {
  it('start never passes --yes and attaches context', () => {
    const a = startArgv('go', [{ id: '1', label: 'lint job log', content: 'x' }], s)
    expect(a).not.toContain('--yes')
    expect(a).toContain('--ai-context-items')
    expect(a.slice(0, 4)).toEqual(['glab', 'duo', 'cli', 'run'])
    expect(a).toContain('--model')
    expect(a).not.toContain('--skill')
  })
  it('approve and reject', () => {
    expect(resumeArgv('S', { approve: true }, s)).toEqual(
      expect.arrayContaining(['--existing-session-id', 'S', '--approval', 'true']),
    )
    const r = resumeArgv('S', { approve: false, reason: 'no' }, s)
    expect(r).toEqual(expect.arrayContaining(['--approval', 'false', '--rejection-reason', 'no']))
  })
})

describe('parseRun', () => {
  it('detects plan checkpoint', () => {
    const r = parseRun(
      JSON.stringify({ session_id: 'S', status: 'INPUT_REQUIRED', plan: ['a', 'b'] }),
      0,
    )
    expect(r).toMatchObject({ sessionId: 'S', state: 'awaiting plan', plan: ['a', 'b'] })
  })
  it('splits numbered text plans', () => {
    expect(parseRun('{"status":"paused","plan":"1. a\\n2) b"}', 0).plan).toEqual(['a', 'b'])
  })
  it('failed on exit code', () => expect(parseRun('garbage', 1).state).toBe('failed'))
  it('done', () =>
    expect(parseRun('{"status":"completed","result":"ok"}', 0)).toMatchObject({
      state: 'done',
      text: 'ok',
    }))
})

describe('contextItems', () => {
  it('encodes chips as a json array of snippets', () => {
    const items = JSON.parse(
      contextItems([{ id: 'job-1', label: 'lint job log', content: 'boom' }]),
    )
    expect(items).toEqual([
      { category: 'snippet', id: 'job-1', content: 'boom', metadata: { title: 'lint job log' } },
    ])
  })
  it('is an empty array for no chips', () => expect(contextItems([])).toBe('[]'))
})

describe('argv edges', () => {
  const all = { model: 'claude_sonnet_5_5', workflowType: 'chat', skill: 'review' }
  it('passes every setting when present, as one value each', () => {
    const a = startArgv('go', [], all)
    expect(a).toEqual(
      expect.arrayContaining([
        '--model',
        'claude_sonnet_5_5',
        '--workflow-type',
        'chat',
        '--skill',
        'review',
      ]),
    )
    expect(a).not.toContain('--ai-context-items')
    expect(a).toContain('--output-format')
  })
  it('keeps a goal with spaces and quotes as a single argv entry', () => {
    const goal = `fix "this" && rm -rf /`
    const a = startArgv(goal, [], s)
    expect(a[a.indexOf('--goal') + 1]).toBe(goal)
  })
  it('never contains --yes in any form', () => {
    const chips = [{ id: '1', label: 'l', content: 'c' }]
    for (const a of [
      startArgv('g', chips, all),
      resumeArgv('S', { approve: true }, all),
      resumeArgv('S', { approve: false, reason: 'r' }, all),
    ]) {
      expect(a.some((x) => x === '--yes' || x === '-y')).toBe(false)
    }
  })
  it('resume carries the session, settings and the rejection reason as the goal', () => {
    const a = resumeArgv('S1', { approve: false, reason: 'too broad' }, all)
    expect(a[a.indexOf('--existing-session-id') + 1]).toBe('S1')
    expect(a[a.indexOf('--goal') + 1]).toBe('too broad')
    expect(a[a.indexOf('--rejection-reason') + 1]).toBe('too broad')
    expect(a).toContain('--model')
  })
  it('approval has no rejection reason', () => {
    expect(resumeArgv('S', { approve: true }, s)).not.toContain('--rejection-reason')
  })
})

describe('parseRun edges', () => {
  it('skips log noise before the document', () => {
    const out = `downloading duo...\n${JSON.stringify({ session_id: 'S', status: 'completed', result: 'ok' })}`
    expect(parseRun(out, 0)).toMatchObject({ sessionId: 'S', state: 'done', text: 'ok' })
  })
  it('reads plan steps given as objects', () => {
    const r = parseRun(
      JSON.stringify({
        workflow_id: 'W',
        status: 'paused',
        plan: [{ description: 'a' }, { title: 'b' }, {}],
      }),
      0,
    )
    expect(r.sessionId).toBe('W')
    expect(r.plan).toEqual(['a', 'b'])
  })
  it('strips bullets from a text plan', () => {
    expect(
      parseRun('{"status":"input_required","plan":"- one\\n* two\\n\\n3. three"}', 0).plan,
    ).toEqual(['one', 'two', 'three'])
  })
  it('a non-zero exit is failed even with a done-looking status', () => {
    expect(parseRun('{"status":"completed"}', 2).state).toBe('failed')
  })
  it('status error is failed', () => expect(parseRun('{"status":"error"}', 0).state).toBe('failed'))
  it('running status', () => expect(parseRun('{"status":"running"}', 0).state).toBe('running'))
  it('empty or garbled output gives no session id', () => {
    expect(parseRun('', 0)).toMatchObject({ sessionId: '', plan: [] })
    expect(parseRun('{broken', 0).sessionId).toBe('')
  })
  it('awaiting plan needs a checkpoint status, not just a plan in a finished run', () => {
    expect(parseRun('{"status":"completed","plan":["a"]}', 0).state).toBe('done')
  })
})
