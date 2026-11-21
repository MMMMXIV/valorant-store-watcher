import type { StoreSnapshot } from '../types'

const DAY = 86_400_000
/** VALORANT's daily store rotates at 00:00 UTC (09:00 JST). Used only when the source gives no time. */
export function utcDayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return { start, end: new Date(start.getTime() + DAY) }
}

/**
 * Stable identifier for a store rotation period.
 * Uses the period END (next refresh) rounded to 15 minutes, because remaining-seconds values drift
 * by a few seconds between requests. Falls back to the UTC day.
 */
export function computePeriodKey(s: Pick<StoreSnapshot, 'periodEnd' | 'fetchedAt'>): string {
  if (s.periodEnd) {
    const t = new Date(s.periodEnd).getTime()
    if (!Number.isNaN(t)) {
      const q = 15 * 60_000
      return `end:${new Date(Math.round(t / q) * q).toISOString()}`
    }
  }
  const { end } = utcDayBounds(new Date(s.fetchedAt))
  return `end:${end.toISOString()}`
}
