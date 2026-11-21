import type { Settings } from '../settings'
import type { MonitorState } from '../types'
import { nextOccurrence, previousOccurrence } from '../util/time'
import type { StoreCheckService } from './StoreCheckService'

export interface CheckPlan {
  dueAt: Date
  reason: 'source-refresh' | 'scheduled' | 'catch-up' | 'retry' | 'after-retries'
}

/** Minimum spacing between automatic fetches, to avoid hammering any API. */
export const MIN_AUTO_INTERVAL_MS = 10 * 60_000

const ms = (iso: string | null): number | null => (iso ? new Date(iso).getTime() : null)

/**
 * Decides when the next automatic check should run (pure function).
 *  1. After a failure: retry using settings.retryMinutes backoff.
 *  2. If the source told us when the store refreshes (periodEnd): refresh time + delay.
 *  3. Otherwise: the configured daily time in settings.timezone; if the most recent slot was
 *     missed (PC asleep/off), the check is due immediately (catch-up).
 */
export function planNextCheck(now: Date, settings: Settings, state: MonitorState): CheckPlan {
  const lastAttempt = ms(state.lastAttemptAt)
  const lastSuccess = ms(state.lastSuccessAt)
  const fails = state.consecutiveFailures

  if (fails > 0 && lastAttempt !== null && fails <= settings.retryMinutes.length) {
    return { dueAt: new Date(lastAttempt + settings.retryMinutes[fails - 1] * 60_000), reason: 'retry' }
  }

  let plan: CheckPlan
  const periodEnd = ms(state.lastPeriodEnd)
  if (periodEnd !== null && lastSuccess !== null && fails === 0) {
    plan = { dueAt: new Date(periodEnd + settings.checkDelayMinutes * 60_000), reason: 'source-refresh' }
  } else {
    const prevSlot = previousOccurrence(now, settings.checkTime, settings.timezone)
    if (lastSuccess === null || lastSuccess < prevSlot.getTime()) plan = { dueAt: prevSlot, reason: 'catch-up' }
    else plan = { dueAt: nextOccurrence(now, settings.checkTime, settings.timezone), reason: 'scheduled' }
  }

  if (fails > settings.retryMinutes.length && lastAttempt !== null) {
    // retries exhausted: wait for the next daily slot after the last attempt
    const after = nextOccurrence(new Date(lastAttempt), settings.checkTime, settings.timezone)
    if (after.getTime() > plan.dueAt.getTime()) plan = { dueAt: after, reason: 'after-retries' }
  }
  if (lastAttempt !== null && plan.dueAt.getTime() < lastAttempt + MIN_AUTO_INTERVAL_MS && plan.reason !== 'retry') {
    plan = { ...plan, dueAt: new Date(lastAttempt + MIN_AUTO_INTERVAL_MS) }
  }
  return plan
}

export interface SchedulerDeps {
  service: StoreCheckService
  getSettings: () => Settings
  getState: () => MonitorState
  supportsAutomatic: () => boolean
  now?: () => Date
  tickMs?: number
  onPlan?: (plan: CheckPlan | null) => void
}

/**
 * Tick-based scheduler (robust against sleep/hibernate and clock changes: it re-evaluates
 * the plan every tick instead of relying on one long setTimeout).
 */
export class MonitorScheduler {
  private timer: NodeJS.Timeout | null = null
  private lastPlan: CheckPlan | null = null

  constructor(private deps: SchedulerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 30_000)
    void this.tick('startup')
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  get running(): boolean {
    return this.timer !== null
  }

  plan(): CheckPlan | null {
    const s = this.deps.getSettings()
    if (!s.autoCheckEnabled || !this.deps.supportsAutomatic()) return null
    return planNextCheck(this.now(), s, this.deps.getState())
  }

  /** Evaluates the plan and runs a check if due. Returns true if a check ran. */
  async tick(kind: 'startup' | 'tick' = 'tick'): Promise<boolean> {
    const plan = this.plan()
    this.lastPlan = plan
    this.deps.onPlan?.(plan)
    if (!plan || this.deps.service.isRunning) return false
    if (this.now().getTime() < plan.dueAt.getTime()) return false
    const trigger = plan.reason === 'retry' ? 'retry' : kind === 'startup' || plan.reason === 'catch-up' ? 'startup' : 'auto'
    await this.deps.service.runCheck(trigger)
    this.lastPlan = this.plan()
    this.deps.onPlan?.(this.lastPlan)
    return true
  }

  get currentPlan(): CheckPlan | null {
    return this.lastPlan
  }
}
