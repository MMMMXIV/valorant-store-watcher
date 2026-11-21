/** Minimal cookie jar helpers for the auth.riotgames.com session cookies. */
export type CookieJar = Record<string, string>

/** Parses Set-Cookie header values into name→value (expired/deleted cookies are removed). */
export function applySetCookies(jar: CookieJar, setCookies: string[]): CookieJar {
  const out = { ...jar }
  for (const sc of setCookies) {
    const [pair, ...attrs] = sc.split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    const expired = attrs.some((a) => {
      const [k, v] = a.split('=').map((x) => x?.trim().toLowerCase())
      if (k === 'max-age') return Number(v) <= 0
      if (k === 'expires') return new Date(v).getTime() < Date.now()
      return false
    })
    if (expired || value === '') delete out[name]
    else out[name] = value
  }
  return out
}

export function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .filter(([k, v]) => /^[\w.-]+$/.test(k) && !/[;\r\n]/.test(v))
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/** Accepts "abc", "ssid=abc" or a full "a=1; ssid=abc" cookie string. */
export function parseSsidInput(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  const m = /(?:^|;\s*)ssid=([^;\s]+)/.exec(t)
  const v = m ? m[1] : t.includes('=') ? null : t
  return v && /^[\w.\-~+/=]{20,4096}$/.test(v) ? v : null
}
