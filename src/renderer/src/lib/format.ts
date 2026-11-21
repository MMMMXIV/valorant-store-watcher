export const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' } as const

export function fmtDateTime(iso: string | null | undefined, tz = 'Asia/Tokyo'): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('ja-JP', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d)
}

export function fmtDate(iso: string | null | undefined, tz = 'Asia/Tokyo'): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('ja-JP', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
}

export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const diff = new Date(iso).getTime() - now
  const abs = Math.abs(diff)
  const m = Math.round(abs / 60000)
  const txt = m < 1 ? '1分未満' : m < 60 ? `${m}分` : m < 1440 ? `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}` : `${Math.floor(m / 1440)}日`
  return diff >= 0 ? `あと${txt}` : `${txt}前`
}

export const fmtVp = (n: number | null | undefined): string => (n == null ? '— VP' : `${n.toLocaleString('ja-JP')} VP`)

/** Period date (store day) shown to users: periodStart, else periodEnd - 1 day. */
export function periodDay(s: { periodStart: string | null; periodEnd: string | null; fetchedAt: string }): string {
  if (s.periodStart) return s.periodStart
  if (s.periodEnd) return new Date(new Date(s.periodEnd).getTime() - 86_400_000).toISOString()
  return s.fetchedAt
}
