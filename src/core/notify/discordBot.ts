/**
 * Discord BOT direct-message notifier (REST only, no gateway connection).
 * Docs (discord/discord-api-docs, 2026-11): POST /users/@me/channels {recipient_id} → DM channel,
 * then POST /channels/{id}/messages. Error 50278 = no mutual guild, 50007 = user blocks DMs.
 */
import { fetchWithTimeout, type FetchLike } from '../util/http'
import { sleep } from '../util/time'
import { DiscordPermanentError, type DiscordPayload, type SendOptions, type SendResult } from './discord'

export const DISCORD_API = 'https://discord.com/api/v10'
export const BOT_TOKEN_RE = /^[\w-]{20,40}\.[\w-]{4,10}\.[\w-]{20,60}$/
export const SNOWFLAKE_RE = /^\d{15,21}$/

export function isValidBotToken(t: string): boolean {
  return BOT_TOKEN_RE.test(t.trim())
}
export function isValidUserId(id: string): boolean {
  return SNOWFLAKE_RE.test(id.trim())
}

const ERROR_HINTS: Record<number, string> = {
  50278: 'BOTとあなたに共通のサーバーがありません。BOTを自分のアカウントにインストールするか、自分のサーバーにBOTを招待してください。',
  50007: 'このユーザーにはDMを送れません。Discordのプライバシー設定（サーバーメンバーからのDM）を確認してください。',
  10013: 'ユーザーIDが見つかりません。DiscordのユーザーIDを確認してください。',
  50035: 'ユーザーIDの形式が正しくありません。'
}

interface ApiError {
  code?: number
  message?: string
  retry_after?: number
}

export class DiscordBotClient {
  private dmChannel: { userId: string; channelId: string } | null = null

  constructor(
    private fetchImpl: FetchLike,
    private token: string,
    private opts: SendOptions = {}
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ data: T; attempts: number }> {
    const max = this.opts.maxAttempts ?? 5
    const wait = this.opts.sleepFn ?? sleep
    const cap = this.opts.maxRetryWaitMs ?? 60_000
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        const res = await fetchWithTimeout(
          this.fetchImpl,
          `${DISCORD_API}${path}`,
          {
            method,
            headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (valorant-store-watcher, 1.x)' },
            body: body === undefined ? undefined : JSON.stringify(body)
          },
          this.opts.timeoutMs ?? 15000
        )
        const text = await res.text().catch(() => '')
        let json: ApiError & Record<string, unknown> = {}
        try {
          json = text ? JSON.parse(text) : {}
        } catch {
          /* non-JSON */
        }
        if (res.ok) return { data: json as T, attempts: attempt }
        if (res.status === 429) {
          const ms = typeof json.retry_after === 'number' ? Math.ceil(json.retry_after * 1000) : Number(res.headers.get('retry-after') || 1) * 1000
          lastErr = new Error('Discord のレート制限 (429)')
          if (attempt < max) await wait(Math.min(ms + 250, cap))
          continue
        }
        if (res.status >= 500) {
          lastErr = new Error(`Discord サーバーエラー (${res.status})`)
        } else if (res.status === 401) {
          throw new DiscordPermanentError('BOTトークンが無効です。Developer Portal でトークンを再発行して設定し直してください。', 401)
        } else {
          const hint = (json.code && ERROR_HINTS[json.code]) || json.message || '送信内容が拒否されました'
          throw new DiscordPermanentError(`Discord 送信失敗 (${res.status}${json.code ? `/${json.code}` : ''}): ${hint}`, res.status)
        }
      } catch (e) {
        if (e instanceof DiscordPermanentError) throw e
        lastErr = e
      }
      if (attempt < max) await wait(Math.min(1000 * 2 ** (attempt - 1), cap))
    }
    throw lastErr instanceof Error ? lastErr : new Error('Discord への送信に失敗しました')
  }

  /** Bot's application info (id/name) — used to build install links. */
  async application(): Promise<{ id: string; name: string }> {
    const { data } = await this.call<{ id: string; name: string }>('GET', '/oauth2/applications/@me')
    return { id: data.id, name: data.name }
  }

  async sendDm(userId: string, payload: DiscordPayload): Promise<SendResult> {
    let attempts = 0
    if (!this.dmChannel || this.dmChannel.userId !== userId) {
      const r = await this.call<{ id: string }>('POST', '/users/@me/channels', { recipient_id: userId })
      attempts += r.attempts
      this.dmChannel = { userId, channelId: r.data.id }
    }
    // bots cannot override username/avatar on normal messages
    const { username: _u, ...body } = payload
    const r = await this.call('POST', `/channels/${this.dmChannel.channelId}/messages`, body)
    return { attempts: attempts + r.attempts }
  }
}

/** Install links: user-install (no server) and server invite (for a private server with the bot). */
export function botInstallLinks(appId: string): { userInstall: string; serverInvite: string } {
  return {
    userInstall: `https://discord.com/oauth2/authorize?client_id=${appId}&integration_type=1&scope=applications.commands`,
    serverInvite: `https://discord.com/oauth2/authorize?client_id=${appId}&integration_type=0&scope=bot&permissions=0`
  }
}
