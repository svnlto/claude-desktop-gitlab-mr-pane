import type { CoreEngineInterface, Register, RenderChildren } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Chip, DuoSettings, Mr, Run, Ui } from '../types'
import type { Decision, Phase } from './lib/duo'
import { describeDuoFailure, parseRun, resumeArgv, startArgv } from './lib/duo'
import {
  describeGlabFailure,
  firstLine,
  formatDuration,
  parseJson,
  pipelineState,
  relativeTime,
  tailLog,
  toApprovals,
  toJobs,
  toMrBase,
  toThreads,
  transitions,
  truncate,
} from './lib/parse'

const PANE = 'gitlab-mr'
const POLL_MS = 30_000
const DUO_TIMEOUT_MS = 600_000

const mrAtom = atom({ plugin: 'gitlab-mr-pane', key: 'mr' } as const, null, { shape: 'mr-1' })
const chipsAtom = atom({ plugin: 'gitlab-mr-pane', key: 'chips' } as const, [], {
  shape: 'chips-1',
})
const runsAtom = atom({ plugin: 'gitlab-mr-pane', key: 'runs' } as const, [], { shape: 'runs-2' })
const goalAtom = atom({ plugin: 'gitlab-mr-pane', key: 'goal' } as const, '', { shape: 'goal-1' })
const reasonAtom = atom({ plugin: 'gitlab-mr-pane', key: 'reason' } as const, '', {
  shape: 'reason-1',
})
const settingsAtom = atom(
  { plugin: 'gitlab-mr-pane', key: 'settings' } as const,
  { model: '', workflowType: '', skill: '' } satisfies DuoSettings,
  { shape: 'settings-1' },
)
const uiAtom = atom(
  { plugin: 'gitlab-mr-pane', key: 'ui' } as const,
  {
    error: '',
    note: '',
    isBusy: false,
    isSettingsOpen: false,
    isRejecting: false,
    selectedRun: '',
  } satisfies Ui,
  { shape: 'ui-2' },
)

const ICONS: Record<string, { d: string; color?: string }> = {
  mr: {
    d: 'M6 8v8M18 16v-5a3 3 0 0 0-3-3h-3M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  },
  refresh: { d: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5' },
  check: { d: 'M5 12l5 5 9-10', color: '#2da44e' },
  x: { d: 'M6 6l12 12M18 6L6 18', color: '#d1453b' },
  spinner: { d: 'M12 3a9 9 0 1 0 9 9', color: '#0969da' },
  pause: { d: 'M8 5v14M16 5v14', color: '#8b949e' },
  sparkles: { d: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z' },
  paperclip: { d: 'M20 11l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8' },
  jobs: { d: 'M4 6h16M4 12h16M4 18h10' },
  threads: { d: 'M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z' },
  runs: { d: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z' },
}
const GLYPHS: Record<string, string> = {
  mr: 'MR',
  refresh: 'refresh',
  check: 'ok',
  x: 'x',
  spinner: '..',
  pause: '||',
  sparkles: '*',
  paperclip: '@',
  jobs: '≡',
  threads: '#',
  runs: '↻',
}
const svg = (name: string): string => {
  const i = ICONS[name] ?? { d: '' }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${i.color ?? 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${i.d}"/></svg>`
}
const jobIcon = (status: string): string =>
  status === 'success'
    ? 'check'
    : status === 'failed'
      ? 'x'
      : status === 'running'
        ? 'spinner'
        : 'pause'

type Engine = CoreEngineInterface

const run = async ($: Engine, argv: readonly string[], timeoutMs?: number) =>
  $.process.run(argv, timeoutMs ? { timeoutMs } : undefined)

type Fetched = { ok: true; out: string } | { ok: false; message: string }

const api = async ($: Engine, path: string): Promise<Fetched> => {
  const r = await run($, ['glab', 'api', path])
  return r.exitCode === 0
    ? { ok: true, out: r.stdout }
    : { ok: false, message: describeGlabFailure(r.stdout, r.stderr).message }
}

const attempt = async ($: Engine, work: () => Promise<unknown>): Promise<void> => {
  try {
    await work()
    $.ui.invalidate('ui.render')
  } catch (err) {
    await setBusy($, false, truncate(err instanceof Error ? err.message : String(err), 160))
  }
}

const refresh = async ($: Engine): Promise<unknown> => {
  const view = await run($, ['glab', 'mr', 'view', '--output', 'json'])
  const failure = view.exitCode === 0 ? null : describeGlabFailure(view.stdout, view.stderr)
  const base = failure ? null : toMrBase(parseJson(view.stdout))
  if (failure?.kind === 'no-mr' || failure?.kind === 'no-gitlab' || (!failure && !base)) {
    await update($, mrAtom, () => null)
    await update($, uiAtom, (u) => ({
      ...u,
      error: '',
      note:
        failure?.kind === 'no-gitlab'
          ? 'No GitLab remote for this directory, so there is no merge request to show.'
          : 'No merge request for the current branch.',
    }))
    return
  }
  if (!base) return stale($, failure?.message ?? 'glab failed')

  const mrPath = `projects/:id/merge_requests/${base.iid}`
  const [approvals, discussions, jobs] = await Promise.all([
    api($, `${mrPath}/approvals`),
    api($, `${mrPath}/discussions?per_page=100`),
    base.pipelineId === null
      ? Promise.resolve<Fetched>({ ok: true, out: '[]' })
      : api($, `projects/:id/pipelines/${base.pipelineId}/jobs?per_page=100`),
  ])
  const failed = [approvals, discussions, jobs].find((f) => !f.ok)
  if (failed && !failed.ok) return stale($, failed.message)
  if (!approvals.ok || !discussions.ok || !jobs.ok) return null

  const { required, given } = toApprovals(parseJson(approvals.out))
  const next: Mr = {
    ...base,
    approvalsRequired: required,
    approvalsGiven: given,
    jobs: toJobs(parseJson(jobs.out)),
    threads: toThreads(parseJson(discussions.out)),
  }
  const prev = await read($, mrAtom)
  await update($, mrAtom, () => next)
  await update($, uiAtom, (u) => ({ ...u, error: '', note: '' }))
  for (const text of transitions(prev, next)) $.ui.toast(text)
}

// Keeps the last good merge request on screen and says why it is out of date.
const stale = ($: Engine, message: string) =>
  update($, uiAtom, (u) => ({ ...u, error: `Could not refresh: ${truncate(message, 140)}` }))

const fetchLog = async ($: Engine, jobId: number): Promise<Fetched> => {
  const r = await api($, `projects/:id/jobs/${jobId}/trace`)
  return r.ok ? { ok: true, out: tailLog(r.out) } : r
}

const attachJobLog = async ($: Engine, job: { id: number; name: string }) => {
  const log = await fetchLog($, job.id)
  if (!log.ok)
    return setBusy($, false, `Could not fetch the ${job.name} log: ${truncate(log.message, 120)}`)
  await update($, uiAtom, (u) => ({ ...u, error: '' }))
  return addChip($, { id: `job-${job.id}`, label: `${job.name} job log`, content: log.out })
}

const addChip = ($: Engine, chip: Chip) =>
  update($, chipsAtom, (cs) => [...cs.filter((c) => c.id !== chip.id), chip])

const setBusy = ($: Engine, isBusy: boolean, error = '') =>
  update($, uiAtom, (u) => ({ ...u, isBusy, error }))

const record = ($: Engine, name: string, argv: readonly string[], phase: Phase, prior?: Run) =>
  attempt($, async () => {
    await setBusy($, true)
    const r = await run($, argv, DUO_TIMEOUT_MS)
    const parsed = parseRun(r.stdout, r.exitCode, phase)
    if (parsed.state === 'failed' && prior) {
      const why = describeDuoFailure(r.stdout, r.stderr)
      return setBusy(
        $,
        false,
        `Could not continue the run, it still awaits your decision: ${truncate(why, 120)}`,
      )
    }
    const entry: Run = {
      sessionId: parsed.sessionId || prior?.sessionId || `local-${Date.now()}`,
      name,
      state: parsed.state,
      at: Date.now(),
      plan: parsed.plan,
      summary: truncate(parsed.text, 400),
    }
    await update($, runsAtom, (rs) =>
      [entry, ...rs.filter((x) => x.sessionId !== entry.sessionId)].slice(0, 20),
    )
    await update($, uiAtom, (u) => ({ ...u, selectedRun: entry.sessionId }))
    await setBusy(
      $,
      false,
      parsed.state === 'failed' ? truncate(describeDuoFailure(r.stdout, r.stderr), 160) : '',
    )
  })

const decide = async ($: Engine, r: Run, d: Decision) => {
  const s = await read($, settingsAtom)
  await update($, uiAtom, (u) => ({ ...u, isRejecting: false }))
  await record($, r.name, resumeArgv(r.sessionId, d, s), d.approve ? 'execute' : 'plan', r)
}

const start = async ($: Engine) => {
  const [goal, chips, s] = await Promise.all([
    read($, goalAtom),
    read($, chipsAtom),
    read($, settingsAtom),
  ])
  if (!goal.trim()) return setBusy($, false, 'Enter a goal first')
  await record($, truncate(goal.trim(), 40), startArgv(goal.trim(), chips, s), 'plan')
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mr', description: 'Open the GitLab merge request pane' })
    await $.command.register({
      name: 'mr-fix',
      description: 'Put the log of a failed job in the prompt',
      argumentHint: '<job>',
    })
    void $.ui.open({ id: PANE, title: 'Merge request' })
    void attempt($, () => refresh($))
    $.clock.every(POLL_MS, () => void attempt($, () => refresh($)))

    return next(e)
  })

  on('command.run', { command: 'mr' }, async ($) => {
    const opened = await $.ui.open({ id: PANE, title: 'Merge request' })
    await refresh($)

    return {
      text: opened.isPlaced
        ? 'Merge request pane opened.'
        : `Merge request pane is open but not shown yet (${opened.reason}). Widen the window or open it from the pane menu.`,
    }
  })

  on('command.run', { command: 'mr-fix' }, async ($, e) => {
    await refresh($)
    const mr = await read($, mrAtom)
    const want = e.args.trim()
    const failed = (mr?.jobs ?? []).filter((j) => j.isFailed)
    const job = failed.find((j) => !want || j.name === want)
    if (!job) return { text: want ? `No failed job named ${want}.` : 'No failed jobs.' }
    const log = await fetchLog($, job.id)
    if (!log.ok) return { text: `Could not fetch the ${job.name} log: ${log.message}` }
    await $.prompt.fill({
      text: `The ${job.name} job failed. Fix it. Log tail:\n\n${log.out}`,
      mode: 'replace',
    })

    return { text: `Log of ${job.name} put in the prompt.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button, Input } = t
    const Svg = 'Svg' in t ? t.Svg : undefined
    const [mr, chips, runs, goal, reason, settings, ui] = await Promise.all([
      read($, mrAtom),
      read($, chipsAtom),
      read($, runsAtom),
      read($, goalAtom),
      read($, reasonAtom),
      read($, settingsAtom),
      read($, uiAtom),
    ])
    const now = await $.clock.now()
    const icon = (name: string) =>
      Svg ? (
        <Svg source={svg(name)} alt={name} width={16} height={16} />
      ) : (
        <Text dimColor>{GLYPHS[name]}</Text>
      )
    const pipeline = mr ? pipelineState(mr.pipelineStatus, mr.jobs) : 'none'
    const openRuns =
      runs.find((r) => r.sessionId === ui.selectedRun) ??
      runs.find((r) => r.state === 'awaiting plan')
    const awaiting = openRuns?.state === 'awaiting plan' ? openRuns : undefined
    const short = !!mr && mr.approvalsGiven < mr.approvalsRequired
    const set = (patch: Partial<DuoSettings>) =>
      update($, settingsAtom, (s) => ({ ...s, ...patch }))
    const row = (key: string, ...kids: RenderChildren[]) => (
      <Box key={key} flexDirection="row" gap={1} alignItems="center">
        {kids}
      </Box>
    )
    const badge = (color: string, text: string) => (
      <Box borderStyle="round" borderColor={color} paddingX={1}>
        <Text color={color}>{text}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1} padding={1}>
        {row(
          'head',
          icon('mr'),
          <Text bold>{mr ? truncate(`!${mr.iid} ${mr.title}`, 48) : 'Merge request'}</Text>,
          <Button key="refresh" label="↻" hotkey="r" plain onPress={() => refresh($)} />,
        )}
        <Text dimColor>
          {mr
            ? `${mr.source} -> ${mr.target} · updated ${relativeTime(now, mr.updatedAt)}`
            : ui.note || 'No merge request for the current branch.'}
        </Text>
        {ui.error && <Text color="error">{truncate(ui.error, 80)}</Text>}
        {mr && (
          <Box flexDirection="row" gap={1}>
            {badge(
              pipeline === 'failed' ? 'error' : pipeline === 'passed' ? 'success' : 'subtle',
              `pipeline ${pipeline === 'none' ? 'none' : pipeline}`,
            )}
            {badge(
              short ? 'warning' : 'success',
              `approvals ${mr.approvalsGiven} of ${mr.approvalsRequired}`,
            )}
            {badge(mr.threads.length ? 'warning' : 'subtle', `${mr.threads.length} open threads`)}
          </Box>
        )}
        {mr && mr.jobs.length > 0 && (
          <Box flexDirection="column">
            {row('jobs-head', icon('jobs'), <Text bold>Pipeline jobs</Text>)}
            {mr.jobs.map((j) =>
              row(
                `job-${j.id}`,
                icon(jobIcon(j.status)),
                <Text>{j.name}</Text>,
                <Text dimColor>{formatDuration(j.durationS) || j.status}</Text>,
                j.isFailed && (
                  <Button
                    key={`add-${j.id}`}
                    label="Add to Duo ↗"
                    plain
                    onPress={() => attachJobLog($, j)}
                  />
                ),
              ),
            )}
          </Box>
        )}
        {mr && mr.threads.length > 0 && (
          <Box flexDirection="column">
            {row('threads-head', icon('threads'), <Text bold>Open threads</Text>)}
            {mr.threads.map((th) => {
              const where = th.path ? `${th.path}${th.line ? `:${th.line}` : ''}` : 'general'
              return row(
                `th-${th.id}`,
                <Text dimColor>{where}</Text>,
                <Text>{truncate(firstLine(th.text), 40)}</Text>,
                <Button
                  key={`att-${th.id}`}
                  label="Attach"
                  plain
                  onPress={() =>
                    addChip($, {
                      id: `th-${th.id}`,
                      label: `thread: ${where}`,
                      content: `${where}\n${th.text}`,
                    })
                  }
                />,
              )
            })}
          </Box>
        )}
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {icon('sparkles')}
            <Text bold>GitLab Duo</Text>
            <Box flexGrow={1} />
            <Text dimColor>
              {settings.model || 'default model'} · {settings.workflowType || 'default workflow'}
            </Text>
          </Box>
          {chips.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {chips.map((c) => (
                <Box
                  key={`chip-${c.id}`}
                  flexDirection="row"
                  alignItems="center"
                  gap={1}
                  borderStyle="round"
                  borderColor="subtle"
                  paddingX={1}
                >
                  {icon('paperclip')}
                  <Text>{c.label}</Text>
                  <Button
                    key={`rm-${c.id}`}
                    label="×"
                    plain
                    onPress={() => update($, chipsAtom, (cs) => cs.filter((x) => x.id !== c.id))}
                  />
                </Box>
              ))}
            </Box>
          )}
          <Input
            key="goal"
            label="Goal"
            placeholder="What should Duo do?"
            value={goal}
            onInput={(v) => update($, goalAtom, () => v)}
            onSubmit={(v) => update($, goalAtom, () => v)}
          />
          {row(
            'duo-actions',
            <Button
              key="run"
              label="Run in plan mode (g) ↗"
              hotkey="g"
              variant="primary"
              onPress={() => start($)}
            />,
            <Button
              key="settings"
              label="Settings (s)"
              hotkey="s"
              variant="secondary"
              onPress={() =>
                update($, uiAtom, (u) => ({ ...u, isSettingsOpen: !u.isSettingsOpen }))
              }
            />,
          )}
          {ui.isBusy && <Text dimColor>Duo is working…</Text>}
          {ui.isSettingsOpen && (
            <Box flexDirection="column">
              <Input
                key="model"
                label="Model"
                placeholder="gitlab model identifier"
                value={settings.model}
                onInput={(v) => set({ model: v })}
                onSubmit={(v) => set({ model: v })}
              />
              <Input
                key="wf"
                label="Workflow type"
                placeholder="chat"
                value={settings.workflowType}
                onInput={(v) => set({ workflowType: v })}
                onSubmit={(v) => set({ workflowType: v })}
              />
              <Input
                key="skill"
                label="Skill"
                placeholder="skill name"
                value={settings.skill}
                onInput={(v) => set({ skill: v })}
                onSubmit={(v) => set({ skill: v })}
              />
            </Box>
          )}
        </Box>
        {awaiting && (
          <Box flexDirection="column" borderStyle="round" borderColor="warning" padding={1} gap={1}>
            <Text bold color="warning">
              Plan needs your approval
            </Text>
            {awaiting.plan.map((s, i) => (
              <Text key={`s${i}`}>
                {i + 1}. {s}
              </Text>
            ))}
            {ui.isRejecting ? (
              <Box flexDirection="column">
                <Input
                  key="reason"
                  label="Reason"
                  value={reason}
                  onInput={(v) => update($, reasonAtom, () => v)}
                  onSubmit={(v) => decide($, awaiting, { approve: false, reason: v })}
                  submitLabel="reject"
                />
              </Box>
            ) : (
              row(
                'plan-actions',
                <Button
                  key="approve"
                  label="Approve (a) ↗"
                  hotkey="a"
                  variant="primary"
                  onPress={() => decide($, awaiting, { approve: true })}
                />,
                <Button
                  key="reject"
                  label="Reject with reason… (x)"
                  hotkey="x"
                  variant="secondary"
                  onPress={() => update($, uiAtom, (u) => ({ ...u, isRejecting: true }))}
                />,
              )
            )}
          </Box>
        )}
        <Box flexDirection="column">
          {row('runs-head', icon('runs'), <Text bold>Recent runs</Text>)}
          {runs.length > 0 ? (
            runs.map((r) =>
              row(
                `run-${r.sessionId}`,
                <Button
                  key={`open-${r.sessionId}`}
                  label={truncate(r.name, 28)}
                  plain
                  onPress={() =>
                    update($, uiAtom, (u) => ({
                      ...u,
                      selectedRun: r.sessionId,
                      isRejecting: false,
                    }))
                  }
                />,
                <Text
                  color={
                    r.state === 'awaiting plan'
                      ? 'warning'
                      : r.state === 'failed'
                        ? 'error'
                        : undefined
                  }
                  dimColor={r.state === 'done'}
                >
                  {r.state}
                </Text>,
                <Text dimColor>{relativeTime(now, r.at)}</Text>,
              ),
            )
          ) : (
            <Text dimColor>No runs yet</Text>
          )}
          {openRuns?.state === 'done' && openRuns.summary && <Text>{openRuns.summary}</Text>}
        </Box>
      </Box>
    )
  })
}
