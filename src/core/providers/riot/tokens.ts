/** Extracts tokens from the opt_in redirect URL fragment (#access_token=...&id_token=...&expires_in=...). */
export function parseTokenRedirect(url: string): { accessToken: string; idToken: string | null; expiresIn: number } | null {
  const hash = url.indexOf('#')
  if (hash < 0) return null
  const params = new URLSearchParams(url.slice(hash + 1))
  const accessToken = params.get('access_token')
  if (!accessToken) return null
  return { accessToken, idToken: params.get('id_token'), expiresIn: Number(params.get('expires_in') ?? 3600) || 3600 }
}

/** Reads the (unverified) JWT payload — only used for `sub` (puuid) and `exp`. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
