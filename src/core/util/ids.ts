const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Normalizes a Riot/Valorant-API uuid: trims, lowercases, strips braces. Returns null if invalid. */
export function normalizeUuid(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const v = input.trim().replace(/^\{|\}$/g, '').toLowerCase()
  return UUID_RE.test(v) ? v : null
}

export function isUuid(input: unknown): input is string {
  return normalizeUuid(input) !== null
}

/** Normalizes a name for lenient lookup (manual input only): NFKC, lowercase, collapse spaces. */
export function normalizeName(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/[\s　・･\-_]+/g, ' ').trim()
}
