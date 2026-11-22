import type { MatchResult, Priority, ResolvedOffer } from '../types'
import { HttpError, fetchWithTimeout, type FetchLike } from '../util/http'
import { formatZonedDate, sleep } from '../util/time'

export const WEBHOOK_URL_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d{5,30}\/[\w-]{20,100}$/

export function isValidWebhookUrl(url: string): boolean {
  return WEBHOOK_URL_RE.test(url.trim())
}

export interface DiscordEmbed {
  title?: string
  description?: string
  color?: number
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  image?: { url: string }
  thumbnail?: { url: string }
  footer?: { text: string }
  timestamp?: string
}

export interface DiscordPayload {
  username?: string
  content?: string
  embeds?: DiscordEmbed[]
  allowed_mentions?: { parse: string[] }
}

const RED = 0xff4655
const NAVY = 0x0f1923
const PRIORITY_LABEL: Record<Priority, string> = { high: '高', normal: '中', low: '低' }
const HEADER = '🎯 **VALORANT STORE WATCHER**'

const fmtVp = (n: number | null): string => (n == null ? '不明' : `${n.toLocaleString('ja-JP')} VP`)

function skinEmbed(offer: ResolvedOffer, tz: string, periodDate: Date, priority?: Priority): DiscordEmbed {
  const s = offer.skin
  const img = s?.renderUrl ?? s?.iconUrl
  const fields = [
    { name: '💰 価格', value: fmtVp(offer.price), inline: true },
    { name: '🔫 武器', value: s?.weaponNameJa || '不明', inline: true }
  ]
  if (priority) fields.push({ name: '⭐ 優先度', value: PRIORITY_LABEL[priority], inline: true })
  fields.push({ name: '🕒 ストア更新日', value: formatZonedDate(periodDate, tz), inline: true })
  if (s?.tierName) fields.push({ name: '💎 レアリティ', value: s.tierName, inline: true })
  return {
    title: `🔫 ${s?.nameJa ?? '不明なスキン'}`,
    description: s && s.nameEn !== s.nameJa ? s.nameEn : undefined,
    color: priority === 'high' ? RED : s?.tierColor ? parseInt(s.tierColor.slice(1), 16) : NAVY,
    fields,
    ...(img ? { image: { url: img } } : {}),
    footer: { text: 'VALORANT Store Watcher（非公式・Riot Gamesとは無関係）' }
  }
}

/** Splits embeds into messages (Discord allows max 10 embeds per message). */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export function buildWishlistPayloads(matches: MatchResult[], tz: string, periodDate: Date, accountLabel?: string | null): Array<{ payload: DiscordPayload; skinIds: string[] }> {
  const who = accountLabel ? `【${accountLabel}】` : ''
  return chunk(matches, 10).map((part, i) => ({
    skinIds: part.map((m) => m.offer.skinId!),
    payload: {
      username: 'VALORANT Store Watcher',
      content: i === 0 ? `${HEADER}\n${who}ウィッシュリストのスキンがストアに登場しました！（${matches.length}件）` : undefined,
      embeds: part.map((m) => skinEmbed(m.offer, tz, periodDate, m.wish.priority)),
      allowed_mentions: { parse: [] }
    }
  }))
}

export function buildDailyPayload(offers: ResolvedOffer[], tz: string, periodDate: Date, matchedIds: Set<string>, accountLabel?: string | null): DiscordPayload {
  return {
    username: 'VALORANT Store Watcher',
    content: `${HEADER}\n📅 ${formatZonedDate(periodDate, tz)} のストア${accountLabel ? `（${accountLabel}）` : ''}`,
    embeds: offers.slice(0, 10).map((o) => {
      const e = skinEmbed(o, tz, periodDate)
      if (o.skinId && matchedIds.has(o.skinId)) e.title = `⭐ ${e.title}（ウィッシュリスト）`
      // daily overview uses thumbnails to stay compact
      if (e.image) {
        e.thumbnail = e.image
        delete e.image
      }
      return e
    }),
    allowed_mentions: { parse: [] }
  }
}

export function buildErrorPayload(message: string, tz: string, at: Date): DiscordPayload {
  return {
    username: 'VALORANT Store Watcher',
    content: `${HEADER}\n⚠️ ストアチェックでエラーが発生しました`,
    embeds: [{ title: 'エラー内容', description: message.slice(0, 1500), color: 0xffb020, footer: { text: formatZonedDate(at, tz) } }],
    allowed_mentions: { parse: [] }
  }
}

export function buildTestPayload(): DiscordPayload {
  return {
    username: 'VALORANT Store Watcher',
    content: `${HEADER}\n✅ テスト通知です。通知先は正しく設定されています。`,
    embeds: [{ title: '通知テスト', description: 'この通知が見えていれば設定は完了です。', color: RED }],
    allowed_mentions: { parse: [] }
  }
}

export interface SendOptions {
  maxAttempts?: number
  timeoutMs?: number
  maxRetryWaitMs?: number
  sleepFn?: (ms: number) => Promise<void>
}

export interface SendResult {
  attempts: number
}

/** Errors that should not be retried (bad URL, deleted webhook, invalid payload). */
export class DiscordPermanentError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message)
    this.name = 'DiscordPermanentError'
  }
}

/**
 * Sends a webhook message with retries:
 *  - 429: waits `retry_after` (body, seconds) or `Retry-After` header, then retries
 *  - 5xx / network / timeout: exponential backoff (1s, 2s, 4s, ...)
 *  - other 4xx: fails immediately (DiscordPermanentError)
 */
export async function sendWebhook(fetchImpl: FetchLike, url: string, payload: DiscordPayload, opts: SendOptions = {}): Promise<SendResult> {
  const max = opts.maxAttempts ?? 5
  const wait = opts.sleepFn ?? sleep
  const cap = opts.maxRetryWaitMs ?? 60_000
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        `${url.trim()}?wait=true`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
        opts.timeoutMs ?? 15000
      )
      if (res.ok) return { attempts: attempt }
      const text = await res.text().catch(() => '')
      if (res.status === 429) {
        let retryAfterMs = 1000
        try {
          const j = JSON.parse(text) as { retry_after?: number }
          if (typeof j.retry_after === 'number') retryAfterMs = Math.ceil(j.retry_after * 1000)
        } catch {
          const h = Number(res.headers.get('retry-after'))
          if (Number.isFinite(h) && h > 0) retryAfterMs = h * 1000
        }
        lastErr = new HttpError('Discord のレート制限 (429)', 429)
        if (attempt < max) await wait(Math.min(retryAfterMs + 250, cap))
        continue
      }
      if (res.status >= 500) {
        lastErr = new HttpError(`Discord サーバーエラー (${res.status})`, res.status)
      } else {
        const hint = res.status === 401 || res.status === 404 ? 'Webhook URLが無効か削除されています' : '送信内容が拒否されました'
        throw new DiscordPermanentError(`Discord 送信失敗 (${res.status}): ${hint}`, res.status)
      }
    } catch (e) {
      if (e instanceof DiscordPermanentError) throw e
      lastErr = e
    }
    if (attempt < max) await wait(Math.min(1000 * 2 ** (attempt - 1), cap))
  }
  throw lastErr instanceof Error ? lastErr : new Error('Discord への送信に失敗しました')
}
