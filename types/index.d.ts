export type Job = {
  id: number
  name: string
  status: string
  durationS: number | null
  isFailed: boolean
}

export type Thread = { id: string; path: string; line: number | null; text: string }

export type Mr = {
  iid: number
  title: string
  source: string
  target: string
  updatedAt: number
  pipelineId: number | null
  pipelineStatus: string
  approvalsRequired: number
  approvalsGiven: number
  jobs: Job[]
  threads: Thread[]
}

export type Chip = { id: string; label: string; content: string }

export type RunState = 'awaiting plan' | 'running' | 'done' | 'failed'

export type Run = {
  sessionId: string
  name: string
  state: RunState
  at: number
  plan: string[]
  summary: string
}

export type DuoSettings = { model: string; workflowType: string; skill: string }

export type Ui = {
  error: string
  note: string
  progress: string
  isBusy: boolean
  isSettingsOpen: boolean
  isRejecting: boolean
  selectedRun: string
}

declare module 'claude-code' {
  interface PluginState {
    'gitlab-mr-pane': {
      mr: Shaped<Mr | null>
      chips: Shaped<Chip[]>
      runs: Shaped<Run[]>
      goal: Shaped<string>
      reason: Shaped<string>
      settings: Shaped<DuoSettings>
      ui: Shaped<Ui>
    }
  }
}
