import type { TestBody } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]
type Reply = { exitCode?: number; stdout?: string; stderr?: string } | 'throw'
type Routes = Record<string, Reply>

const PANE = {
  plugin: 'gitlab-mr-pane',
  component: 'Pane',
  requestId: 'gitlab-mr',
  props: {
    title: 'Merge request',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const json = (v: unknown): Reply => ({ stdout: JSON.stringify(v) })

const MR_VIEW = 'mr view --output json'
const APPROVALS = 'api projects/:id/merge_requests/7/approvals'
const THREADS = 'api projects/:id/merge_requests/7/discussions?per_page=100'
const JOBS = 'api projects/:id/pipelines/9/jobs?per_page=100'
const TRACE = 'api projects/:id/jobs/1/trace'

const healthy = (): Routes => ({
  [MR_VIEW]: json({
    iid: 7,
    title: 'Fix the linter',
    source_branch: 'fix/lint',
    target_branch: 'main',
    updated_at: '2026-01-01T00:00:00Z',
    head_pipeline: { id: 9, status: 'failed' },
  }),
  [APPROVALS]: json({ approvals_required: 2, approvals_left: 1 }),
  [THREADS]: json([
    {
      id: 't',
      notes: [
        {
          resolvable: true,
          resolved: false,
          body: 'Rename this',
          position: { new_path: 'a.go', new_line: 4 },
        },
      ],
    },
  ]),
  [JOBS]: json([
    { id: 1, name: 'lint', status: 'failed', duration: 12 },
    { id: 2, name: 'unit', status: 'success', duration: 75 },
  ]),
  [TRACE]: { stdout: '\u001b[31mlint error: a.go:4\u001b[0m\n' },
})

// Shape of a real `duo cli run --output-format json` document (duo 10.x, schemaVersion 2.1).
const duoDoc = (response: string, sessionId = 'S'): Reply =>
  json({
    schemaVersion: '2.1',
    sessionId,
    exitCode: 0,
    response,
    elements: [{ type: 'message', role: 'assistant', content: response, isComplete: true }],
    status: 'success',
  })

const PLAN = duoDoc('Plan:\n1. Edit a.go\n2. Run tests\n\nI will wait for your approval.')

const FORBIDDEN_STDERR = [
  '2026-11-25T08:45:45:983 [debug]: fetch: https agent with options initialized',
  '2026-11-25T08:45:50:873 [error]: [WorkflowRailsService] Failed to create the workflow',
  '    AgenticChatForbiddenError: GitLab Duo Agent Platform is not available for this namespace or project.',
  '2026-11-25T08:45:51:179 [info]: [CliExitHandler] Shutdown complete, good bye :)',
].join('\n')

// Stands in for the engine beneath the mod: state kept in memory, glab answered from `routes`.
const harness = (on: On, routes: Routes) => {
  const store = new Map<string, { value: unknown; version: number }>()
  const calls: string[][] = []
  const filled: string[] = []
  const toasts: string[] = []
  on('state.get', (_, e) => ({ value: store.get(e.key) ?? { value: null, version: 0 } }))
  on('state.set', (_, e) => {
    const version = (store.get(e.key)?.version ?? 0) + 1
    store.set(e.key, { value: e.value, version })
    return { value: { isSet: true as const, version } }
  })
  on('clock.now', () => ({ value: Date.parse('2026-01-01T00:00:30Z') }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const joined = e.argv.slice(1).join(' ')
    const key = Object.keys(routes).find((k) => joined === k || joined.startsWith(`${k} `))
    const reply = key ? routes[key] : { exitCode: 1, stderr: `unrouted: ${joined}` }
    if (reply === 'throw') throw new Error('spawn glab ENOENT')
    return {
      value: {
        exitCode: reply?.exitCode ?? 0,
        stdout: reply?.stdout ?? '',
        stderr: reply?.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  return { calls, filled, toasts, routes }
}

const mount = ($: Engine) => $.ui.mount({ ...PANE, surface: 'desktop' })

const screen = async ($: Engine): Promise<string> => {
  const ui = await mount($)
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  await ui.unmount()
  return text
}

const slash = ($: Engine, command: string, args: string) =>
  $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

const duoCalls = (calls: string[][]) => calls.filter((c) => c[1] === 'duo')

// Presses refresh, then reads the pane from a fresh mount.
const refreshed = async ($: Engine): Promise<string> => {
  const ui = await mount($)
  await ui.press({ key: 'refresh' })
  await ui.unmount()
  return screen($)
}

test('the empty pane says there is no merge request', async ($, on) => {
  harness(on, healthy())
  expect(await screen($)).toContain('No merge request for the current branch.')
})

test('the skeleton renders every section even with no data', async ($, on) => {
  harness(on, healthy())
  const s = await screen($)
  for (const section of ['Pipeline jobs', 'Open threads', 'GitLab Duo', 'Recent runs']) {
    expect(s).toContain(section)
  }
})

test('a hard glab failure still renders the skeleton, not just the error', async ($, on) => {
  harness(on, {
    [MR_VIEW]: { exitCode: 1, stdout: '{"error":{"message":"401 Unauthorized"}}', stderr: 'ERROR' },
  })
  const s = await refreshed($)
  expect(s).toContain('Could not refresh: 401 Unauthorized')
  expect(s).toContain('Pipeline jobs')
  expect(s).toContain('GitLab Duo')
  expect(s).not.toContain('!7')
})

test('refresh fills the header, badges, jobs and threads', async ($, on) => {
  harness(on, healthy())
  const s = await refreshed($)
  expect(s).toContain('!7 Fix the linter')
  expect(s).toContain('fix/lint -> main · updated 30s ago')
  expect(s).toContain('Pipeline failed')
  expect(s).toContain('Approvals 1 of 2')
  expect(s).toContain('1 open threads')
  expect(s).toContain('lint12s')
  expect(s).toContain('unit1m 15s')
  expect(s).toContain('a.go:4')
  const ui = await mount($)
  expect(await ui.find({ type: 'Button', text: /Add to Duo/ })).toBeTruthy()
  await ui.unmount()
})

test('a branch with no open merge request is a neutral state, not an error', async ($, on) => {
  const h = harness(on, {
    [MR_VIEW]: {
      exitCode: 1,
      stdout: '{"error":{"message":"no open merge request available for \\"topic\\""}}',
      stderr: '\n   ERROR  \n\n  no open merge request available for "topic".\n',
    },
  })
  const s = await refreshed($)
  expect(s).toContain('No merge request for the current branch.')
  expect(s).not.toContain('Could not refresh')
  expect(h.toasts).toEqual([])
})

test('glab failing on first load shows the reason and no data', async ($, on) => {
  harness(on, {
    [MR_VIEW]: {
      exitCode: 1,
      stdout: '{"error":{"message":"401 Unauthorized"}}',
      stderr: 'ERROR',
    },
  })
  const s = await refreshed($)
  expect(s).toContain('Could not refresh: 401 Unauthorized')
  expect(s).not.toContain('!7')
})

test('a later glab failure keeps the last good data and says it is stale', async ($, on) => {
  const h = harness(on, healthy())
  await refreshed($)
  h.routes[MR_VIEW] = {
    exitCode: 1,
    stderr: '\n   ERROR  \n\n  Get "https://gitlab.example/api": EOF.\n',
  }
  const s = await refreshed($)
  expect(s).toContain('!7 Fix the linter')
  expect(s).toContain('Approvals 1 of 2')
  expect(s).toContain('Could not refresh: Get "https://gitlab.example/api": EOF.')
  expect(h.toasts).toEqual([])
})

test('one failing endpoint does not blank the pane or zero the badges', async ($, on) => {
  const h = harness(on, healthy())
  await refreshed($)
  h.routes[APPROVALS] = { exitCode: 1, stderr: '  403 Forbidden' }
  const s = await refreshed($)
  expect(s).toContain('Approvals 1 of 2')
  expect(s).toContain('Could not refresh: 403 Forbidden')
})

test('toasts fire for a new failure and for going green, not on first load', async ($, on) => {
  const h = harness(on, healthy())
  await refreshed($)
  expect(h.toasts).toEqual([])

  h.routes[JOBS] = json([
    { id: 1, name: 'lint', status: 'failed' },
    { id: 3, name: 'unit', status: 'failed' },
  ])
  await refreshed($)
  expect(h.toasts).toEqual(['Job unit failed'])

  Object.assign(h.routes, healthy())
  h.routes[MR_VIEW] = json({
    iid: 7,
    title: 'Fix the linter',
    source_branch: 'fix/lint',
    target_branch: 'main',
    head_pipeline: { id: 9, status: 'success' },
  })
  h.routes[JOBS] = json([{ id: 1, name: 'lint', status: 'success' }])
  await refreshed($)
  expect(h.toasts).toEqual(['Job unit failed', 'Pipeline passed'])
})

test('a failed job log attaches as a chip that can be removed', async ($, on) => {
  harness(on, healthy())
  await refreshed($)
  const ui = await mount($)
  await ui.press({ key: 'add-1' })
  await ui.unmount()
  expect(await screen($)).toContain('lint job log')

  const again = await mount($)
  await again.press({ key: 'rm-job-1' })
  await again.unmount()
  expect(await screen($)).not.toContain('lint job log')
})

test('a thread attaches as a chip labelled with file and line', async ($, on) => {
  harness(on, healthy())
  await refreshed($)
  const ui = await mount($)
  await ui.press({ key: 'att-t' })
  await ui.unmount()
  expect(await screen($)).toContain('thread: a.go:4')
})

test('a log that cannot be fetched adds no chip and says why', async ($, on) => {
  const h = harness(on, healthy())
  await refreshed($)
  h.routes[TRACE] = { exitCode: 1, stderr: '  404 Not Found' }
  const ui = await mount($)
  await ui.press({ key: 'add-1' })
  await ui.unmount()
  const s = await screen($)
  expect(s).not.toContain('lint job log')
  expect(s).toContain('Could not fetch the lint log: 404 Not Found')
})

test('an empty goal starts nothing', async ($, on) => {
  const h = harness(on, healthy())
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await ui.unmount()
  expect(duoCalls(h.calls)).toEqual([])
  expect(await screen($)).toContain('Enter a goal first')
})

test('a run passes goal, context and settings, and never --yes', async ($, on) => {
  const h = harness(on, { ...healthy(), 'duo cli run': PLAN })
  await refreshed($)
  const chips = await mount($)
  await chips.press({ key: 'add-1' })
  await chips.press({ key: 'settings' })
  await chips.unmount()
  const ui = await mount($)
  await ui.input({ key: 'model', text: 'claude_sonnet_5_5' })
  await ui.input({ key: 'goal', text: 'fix the lint job' })
  expect(duoCalls(h.calls)).toEqual([])
  await ui.press({ key: 'run' })
  await ui.unmount()

  const [argv] = duoCalls(h.calls)
  expect(argv).toEqual(
    expect.arrayContaining(['--model', 'claude_sonnet_5_5', '--output-format', 'json']),
  )
  const goal = argv?.[(argv?.indexOf('--goal') ?? 0) + 1] ?? ''
  expect(goal).toContain('PLAN ONLY')
  expect(goal).toContain('Goal: fix the lint job')
  expect(goal).toContain('<context title="lint job log">')
  expect(goal).toContain('lint error: a.go:4')
  expect(argv).not.toContain('--ai-context-items')
  expect(argv).not.toContain('--yes')
  expect(argv).not.toContain('--dangerously-skip-permissions')
})

test('the plan checkpoint shows the plan, and approving resumes the session', async ($, on) => {
  const h = harness(on, { ...healthy(), 'duo cli run': PLAN })
  const first = await mount($)
  await first.input({ key: 'goal', text: 'fix it' })
  await first.press({ key: 'run' })
  await first.unmount()

  const s = await screen($)
  expect(s).toContain('Plan needs your approval')
  expect(s).toContain('1. Edit a.go')
  expect(s).toContain('2. Run tests')
  expect(s).toContain('awaiting plan')

  h.routes['duo cli run'] = duoDoc('Executed the plan.')
  const ui = await mount($)
  await ui.press({ key: 'approve' })
  await ui.unmount()

  const resume = duoCalls(h.calls)[1]
  expect(resume).toEqual(expect.arrayContaining(['--existing-session-id', 'S']))
  expect(resume?.at(-1)).toContain('Plan approved')
  expect(resume).not.toContain('--yes')
  expect(resume).not.toContain('--dangerously-skip-permissions')
  const after = await screen($)
  expect(after).not.toContain('Plan needs your approval')
  expect(after).toContain('done')
})

test('rejecting asks for a reason and sends it', async ($, on) => {
  const h = harness(on, { ...healthy(), 'duo cli run': PLAN })
  const first = await mount($)
  await first.input({ key: 'goal', text: 'fix it' })
  await first.press({ key: 'run' })
  await first.unmount()

  h.routes['duo cli run'] = duoDoc('1. Smaller step')
  const ui = await mount($)
  await ui.press({ key: 'reject' })
  await ui.unmount()
  const reason = await mount($)
  await reason.input({ key: 'reason', text: 'too broad' })
  await reason.unmount()

  const resume = duoCalls(h.calls)[1]
  expect(resume).toEqual(expect.arrayContaining(['--existing-session-id', 'S']))
  expect(resume?.at(-1)).toContain('Feedback: too broad')
  expect(await screen($)).toContain('1. Smaller step')
})

test('a failed run is recorded as failed, shows the reason and is not left busy', async ($, on) => {
  harness(on, {
    ...healthy(),
    'duo cli run': { exitCode: 1, stderr: FORBIDDEN_STDERR },
  })
  const ui = await mount($)
  await ui.input({ key: 'goal', text: 'fix it' })
  await ui.press({ key: 'run' })
  await ui.unmount()
  const s = await screen($)
  expect(s).toContain('failed')
  expect(s).toContain('GitLab Duo Agent Platform is not available for this namespace or project.')
  expect(s).not.toContain('Duo is working')
  expect(s).not.toContain('Plan needs your approval')
})

test('output that is not a document counts as failed, not done', async ($, on) => {
  harness(on, { ...healthy(), 'duo cli run': { stdout: 'download complete' } })
  const ui = await mount($)
  await ui.input({ key: 'goal', text: 'fix it' })
  await ui.press({ key: 'run' })
  await ui.unmount()
  expect(await screen($)).toContain('failed')
})

test('a run that cannot start clears the busy state and says why', async ($, on) => {
  harness(on, { ...healthy(), 'duo cli run': 'throw' })
  const ui = await mount($)
  await ui.input({ key: 'goal', text: 'fix it' })
  await ui.press({ key: 'run' })
  await ui.unmount()
  const s = await screen($)
  expect(s).toContain('process.run')
  expect(s).not.toContain('Duo is working')
})

test('a failed approval leaves the plan waiting so it can be retried', async ($, on) => {
  const h = harness(on, { ...healthy(), 'duo cli run': PLAN })
  const first = await mount($)
  await first.input({ key: 'goal', text: 'fix it' })
  await first.press({ key: 'run' })
  await first.unmount()

  h.routes['duo cli run'] = { exitCode: 1, stderr: FORBIDDEN_STDERR }
  const ui = await mount($)
  await ui.press({ key: 'approve' })
  await ui.unmount()

  const s = await screen($)
  expect(s).toContain('Plan needs your approval')
  const view = await mount($)
  expect(
    await view.find({
      type: 'Text',
      text: /still awaits your decision: GitLab Duo/,
    }),
  ).toBeTruthy()
  await view.unmount()
})

test('the pane draws on a surface without Svg', async ($, on) => {
  harness(on, healthy())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No merge request/ })).toBeTruthy()
  await ui.unmount()
})

test('/mr-fix puts the failed job log in the prompt', async ($, on) => {
  const h = harness(on, healthy())
  const result = await slash($, 'mr-fix', 'lint')
  expect(result.text).toContain('Log of lint put in the prompt.')
  expect(h.filled[0]).toContain('The lint job failed.')
  expect(h.filled[0]).toContain('lint error: a.go:4')
  expect(h.filled[0]).not.toContain('\u001b')
})

test('/mr-fix reports an unknown job and a missing log without filling the prompt', async ($, on) => {
  const h = harness(on, healthy())
  expect((await slash($, 'mr-fix', 'nope')).text).toBe('No failed job named nope.')
  h.routes[TRACE] = { exitCode: 1, stderr: '  404 Not Found' }
  expect((await slash($, 'mr-fix', '')).text).toContain(
    'Could not fetch the lint log: 404 Not Found',
  )
  expect(h.filled).toEqual([])
})
