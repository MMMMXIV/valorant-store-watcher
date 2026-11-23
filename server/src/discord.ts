import { redact, type FetchLike } from '../../src/core'

const API = 'https://discord.com/api/v10'

export interface SlashCommand {
  name: string
  description: string
  options?: Array<{ name: string; description: string; type: 3; required?: boolean }>
}

/** The slash commands this bot registers (type 3 = string option). */
export const COMMANDS: SlashCommand[] = [
  { name: 'store', description: '今日の自分のストアを表示します', options: [{ name: 'account', description: 'アカウント名（省略で全部）', type: 3 }] },
  { name: 'check', description: '今すぐストアを再取得して表示します', options: [{ name: 'account', description: 'アカウント名（省略で全部）', type: 3 }] },
  { name: 'wishlist', description: 'ウィッシュリストを表示します' },
  { name: 'nightmarket', description: 'ナイトマーケット（割引市）を表示します', options: [{ name: 'account', description: 'アカウント名', type: 3 }] },
  { name: 'bundle', description: '現在のバンドルを表示します', options: [{ name: 'account', description: 'アカウント名', type: 3 }] },
  { name: 'connect', description: 'Riotアカウントを連携します（ログインリンクをDMで送ります）' }
]

/** Registers the slash commands globally for this application (run once at startup). */
export async function registerCommands(fetchImpl: FetchLike, appId: string, botToken: string): Promise<void> {
  const res = await fetchImpl(`${API}/applications/${appId}/commands`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(COMMANDS)
  })
  if (!res.ok) throw new Error(`コマンド登録に失敗 (HTTP ${res.status})`)
}

/** Discord interaction (slash command) — only the fields we use. */
export interface Interaction {
  id: string
  token: string
  type: number
  data?: { name: string; options?: Array<{ name: string; value: string }> }
  member?: { user?: { id: string } }
  user?: { id: string }
}

export const INTERACTION_APPLICATION_COMMAND = 2

export function interactionUserId(i: Interaction): string | null {
  return i.member?.user?.id ?? i.user?.id ?? null
}

export function interactionOptions(i: Interaction): Record<string, string> {
  const out: Record<string, string> = {}
  for (const o of i.data?.options ?? []) out[o.name] = o.value
  return out
}

/** Responds to an interaction (type 4 = channel message with source). */
export async function respondInteraction(fetchImpl: FetchLike, i: Interaction, body: { content?: string; embeds?: unknown[]; flags?: number }): Promise<void> {
  await fetchImpl(`${API}/interactions/${i.id}/${i.token}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 4, data: { allowed_mentions: { parse: [] }, ...body } })
  })
}

/** Sends a DM to a user (open DM channel, then post). */
export async function sendDm(fetchImpl: FetchLike, botToken: string, userId: string, content: string): Promise<void> {
  const ch = await fetchImpl(`${API}/users/@me/channels`, { method: 'POST', headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient_id: userId }) })
  if (!ch.ok) throw new Error(`DMチャンネル作成に失敗 (HTTP ${ch.status})`)
  const channel = (await ch.json()) as { id: string }
  await fetchImpl(`${API}/channels/${channel.id}/messages`, { method: 'POST', headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) })
}

/**
 * Minimal Discord Gateway client (receives slash commands as INTERACTION_CREATE).
 * Uses the built-in global WebSocket (Node 21+). No privileged intents are requested;
 * interactions are delivered without an Interactions Endpoint URL set in the dev portal.
 */
export class GatewayClient {
  private ws: WebSocket | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private seq: number | null = null
  private acked = true
  private closed = false
  private backoffMs = 1000

  constructor(
    private botToken: string,
    private onInteraction: (i: Interaction) => void,
    private log: (m: string) => void = () => undefined
  ) {}

  start(): void {
    this.closed = false
    this.connect()
  }

  stop(): void {
    this.closed = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.ws?.close()
  }

  private connect(): void {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json')
    this.ws = ws
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)))
    ws.addEventListener('close', (ev) => this.onClose(ev.code))
    ws.addEventListener('error', () => this.log('gateway error'))
  }

  private send(op: number, d: unknown): void {
    this.ws?.send(JSON.stringify({ op, d }))
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as { op: number; s: number | null; t: string | null; d: unknown }
    if (msg.s !== null) this.seq = msg.s
    switch (msg.op) {
      case 10: {
        // hello → start heartbeat, identify (intent 0: we only need interactions)
        const interval = (msg.d as { heartbeat_interval: number }).heartbeat_interval
        this.acked = true
        this.heartbeat = setInterval(() => {
          if (!this.acked) {
            this.ws?.close(4000)
            return
          }
          this.acked = false
          this.send(1, this.seq)
        }, interval)
        this.send(2, { token: this.botToken, intents: 0, properties: { os: 'linux', browser: 'vsw', device: 'vsw' } })
        this.backoffMs = 1000
        this.log('gateway connected')
        break
      }
      case 11:
        this.acked = true
        break
      case 0:
        if (msg.t === 'INTERACTION_CREATE') {
          try {
            this.onInteraction(msg.d as Interaction)
          } catch (e) {
            this.log(`interaction handler error: ${redact(e)}`)
          }
        }
        break
      case 7:
      case 9:
        this.ws?.close(4000)
        break
    }
  }

  private onClose(code: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.closed) return
    this.log(`gateway closed (${code}), reconnecting in ${this.backoffMs}ms`)
    setTimeout(() => this.connect(), this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000)
  }
}
