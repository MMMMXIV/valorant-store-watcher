/** Removes secrets (webhook tokens, bearer tokens, JWTs, cookies) from strings before logging. */
export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : input instanceof Error ? `${input.name}: ${input.message}` : safeJson(input)
  s = s.replace(/(discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/gi, '$1***')
  s = s.replace(/(Bearer\s+)[\w\-.~+/=]+/gi, '$1***')
  s = s.replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g, '***JWT***')
  s = s.replace(/((?:ssid|access_token|id_token|token|password|cookie)["'=:\s]+)[^\s"'&;,]+/gi, '$1***')
  return s.length > 2000 ? s.slice(0, 2000) + '…' : s
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function errorMessage(e: unknown): string {
  return redact(e instanceof Error ? e.message : e)
}
