/** Timezone helpers built on Intl (no external tz library needed). */

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    fmtCache.set(tz, f)
  }
  return f
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

export function zonedParts(date: Date, tz: string): ZonedParts {
  const out: Record<string, number> = {}
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second }
}

function offsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/** Converts a wall-clock time in `tz` to a UTC Date. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const off1 = offsetMs(new Date(guess), tz)
  let t = guess - off1
  const off2 = offsetMs(new Date(t), tz)
  if (off2 !== off1) t = guess - off2
  return new Date(t)
}

export function parseHHMM(hhmm: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm)
  if (!m) throw new Error(`時刻の形式が不正です: ${hhmm}`)
  return { hour: Number(m[1]), minute: Number(m[2]) }
}

function addDays(p: ZonedParts, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** Next occurrence (strictly after `now`) of HH:mm in tz. */
export function nextOccurrence(now: Date, hhmm: string, tz: string): Date {
  const { hour, minute } = parseHHMM(hhmm)
  const p = zonedParts(now, tz)
  const today = zonedToUtc(p.year, p.month, p.day, hour, minute, tz)
  if (today.getTime() > now.getTime()) return today
  const n = addDays(p, 1)
  return zonedToUtc(n.year, n.month, n.day, hour, minute, tz)
}

/** Most recent occurrence (<= now) of HH:mm in tz. */
export function previousOccurrence(now: Date, hhmm: string, tz: string): Date {
  const { hour, minute } = parseHHMM(hhmm)
  const p = zonedParts(now, tz)
  const today = zonedToUtc(p.year, p.month, p.day, hour, minute, tz)
  if (today.getTime() <= now.getTime()) return today
  const n = addDays(p, -1)
  return zonedToUtc(n.year, n.month, n.day, hour, minute, tz)
}

export function formatZonedDate(date: Date, tz: string): string {
  const p = zonedParts(date, tz)
  return `${p.year}/${String(p.month).padStart(2, '0')}/${String(p.day).padStart(2, '0')}`
}

export function formatZonedDateTime(date: Date, tz: string): string {
  const p = zonedParts(date, tz)
  return `${formatZonedDate(date, tz)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
