export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** fetch with a hard timeout (AbortController). */
export async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`通信がタイムアウトしました (${Math.round(timeoutMs / 1000)}秒)`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJson<T>(fetchImpl: FetchLike, url: string, timeoutMs = 20000): Promise<T> {
  const res = await fetchWithTimeout(fetchImpl, url, { headers: { Accept: 'application/json' } }, timeoutMs)
  if (!res.ok) throw new HttpError(`HTTP ${res.status} (${new URL(url).host})`, res.status)
  return (await res.json()) as T
}
