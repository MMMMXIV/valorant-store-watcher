import { RiotStoreProvider, RiotAuthRequiredError, parseSsidInput, newAccountKey, accountDisplay, redact, type AuthorizeFn, type CookieJar, type FetchLike } from '../../src/core'
import type { SecretBox } from './crypto'
import { saveAccountCookies, type ServerRiotAccount, type ServerUser, type UserStore } from './userStore'

export const CONSENT_VERSION = '1'

export interface ConnectDeps {
  userStore: UserStore
  box: SecretBox
  fetchImpl: FetchLike
  authorize: AuthorizeFn
  getClientVersion: () => Promise<string>
  now?: () => Date
  tokenTtlMs?: number
}

interface PendingLink {
  discordUserId: string
  expiresAt: number
}

/**
 * The /connect web flow. Riot's login redirects to playvalorant.com (not our server),
 * and a daily-checking server needs the long-lived `ssid` cookie, so the friend logs in on
 * Riot's real page and pastes their `ssid`. We never see their password.
 */
export class ConnectService {
  private links = new Map<string, PendingLink>()

  constructor(private deps: ConnectDeps) {}

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime()
  }

  /** Creates a one-time link token for a Discord user. */
  createLink(discordUserId: string): string {
    const token = newAccountKey() + newAccountKey()
    this.links.set(token, { discordUserId, expiresAt: this.now() + (this.deps.tokenTtlMs ?? 30 * 60_000) })
    return token
  }

  private resolve(token: string): string | null {
    const link = this.links.get(token)
    if (!link || link.expiresAt < this.now()) {
      this.links.delete(token)
      return null
    }
    return link.discordUserId
  }

  tokenValid(token: string): boolean {
    return this.resolve(token) !== null
  }

  /**
   * Validates a pasted ssid and links the account to the Discord user.
   * Requires consent. Returns a human message.
   */
  async submit(token: string, input: { consent: boolean; ssid: string; label?: string }): Promise<{ ok: boolean; message: string }> {
    const discordUserId = this.resolve(token)
    if (!discordUserId) return { ok: false, message: 'リンクの有効期限が切れています。Discordで /connect をやり直してください。' }
    if (!input.consent) return { ok: false, message: 'リスクへの同意が必要です。' }
    const ssid = parseSsidInput(input.ssid)
    if (!ssid) return { ok: false, message: 'ssid の形式が正しくありません。' }

    const user: ServerUser = this.deps.userStore.getUser(discordUserId) ?? {
      discordUserId,
      consentedAt: null,
      consentVersion: null,
      pushToken: null,
      accounts: [],
      wishlistSkinIds: []
    }
    const key = newAccountKey()
    const acc: ServerRiotAccount = { key, label: input.label?.trim().slice(0, 20) || defaultLabel(user), puuid: null, gameName: null, region: null, regionOverride: 'auto', lastPeriodEnd: null, encCookies: null, needsRelogin: false }
    saveAccountCookies(this.deps.box, discordUserId, acc, { ssid })

    const provider = new RiotStoreProvider({
      fetchImpl: this.deps.fetchImpl,
      authorize: this.deps.authorize,
      loadCookies: () => ({ ssid }),
      saveCookies: (jar: CookieJar) => saveAccountCookies(this.deps.box, discordUserId, acc, jar),
      loadAccount: () => (acc.puuid ? { puuid: acc.puuid, gameName: acc.gameName, region: acc.region } : null),
      saveAccount: (a) => {
        if (a) {
          acc.puuid = a.puuid
          acc.gameName = a.gameName
          acc.region = a.region
        }
      },
      getRegionSetting: () => 'auto',
      getClientVersion: this.deps.getClientVersion,
      riskAcknowledged: () => true,
      now: this.deps.now
    })
    try {
      await provider.loginWithSsid(ssid)
    } catch (e) {
      if (e instanceof RiotAuthRequiredError) return { ok: false, message: 'この ssid ではログインできませんでした（期限切れか、値が違います）。' }
      return { ok: false, message: `ログイン確認に失敗しました: ${redact(e)}` }
    }
    // reject duplicate of an already-linked account for this user
    if (user.accounts.some((a) => a.puuid && a.puuid === acc.puuid)) {
      return { ok: false, message: `このアカウント（${acc.gameName ?? ''}）はすでに登録されています。` }
    }
    user.accounts.push(acc)
    user.consentedAt = new Date(this.now()).toISOString()
    user.consentVersion = CONSENT_VERSION
    this.deps.userStore.upsertUser(user)
    this.links.delete(token)
    return { ok: true, message: `${accountDisplay(acc)} を連携しました。Discordで /store を試してください。` }
  }
}

function defaultLabel(u: ServerUser): string {
  const n = u.accounts.length
  return n === 0 ? 'メイン' : n === 1 ? 'サブ' : `アカウント${n + 1}`
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** The consent + ssid-paste page (self-contained HTML). */
export function connectPageHtml(token: string, notice?: string): string {
  const riotUrl = 'https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=1&scope=account%20openid'
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Riot連携</title>
<style>body{font-family:system-ui,"Yu Gothic UI",sans-serif;background:#0b0f17;color:#ece8e1;max-width:640px;margin:0 auto;padding:24px;line-height:1.8}
a{color:#ff4655}code{background:#172131;padding:1px 5px;border-radius:3px}.box{border:1px solid #243045;background:#111824;padding:16px;margin:16px 0}
.danger{border-color:#ff4655;background:rgba(255,70,85,.08)}input,button{font:inherit}input[type=text]{width:100%;box-sizing:border-box;background:#0b0f17;color:#ece8e1;border:1px solid #243045;padding:10px;margin-top:8px}
button{background:#ff4655;color:#fff;border:0;padding:12px 18px;margin-top:12px;cursor:pointer;font-weight:700}ol{padding-left:20px}.note{color:#9aa5b6;font-size:.9em}</style></head>
<body><h1>Riotアカウントの連携</h1>
${notice ? `<div class="box ${/しました/.test(notice) ? '' : 'danger'}">${esc(notice)}</div>` : ''}
<div class="box danger"><b>必ずお読みください</b><ul>
<li>これは Riot 公認ではない非公式サービスです。</li>
<li>ストア確認のため、あなたの<b>ログイン情報（ssid）をサーバーに預けます</b>。これはパスワードに近い情報です。</li>
<li>万一サーバーから漏れた場合、<b>アカウント乗っ取りの危険</b>があります。非公式方式のため規約違反のリスクもあります。</li>
<li>パスワードは預かりません。ログインは Riot 公式ページで行います。</li>
<li>Discordで <code>/disconnect</code> すると、いつでも削除できます。</li>
</ul></div>
<div class="box"><b>手順</b><ol>
<li><a href="${riotUrl}" target="_blank" rel="noopener">Riot公式ページでログイン</a>（新しいタブ・2段階認証もここで）。</li>
<li>ログイン後、ブラウザの開発者ツール（F12）→ Application/ストレージ → Cookie → <code>https://auth.riotgames.com</code> を開く。</li>
<li><code>ssid</code> という Cookie の値をコピー。</li>
<li>下に貼り付けて「連携する」。</li>
</ol>
<form method="POST" action="/connect/submit">
<input type="hidden" name="token" value="${esc(token)}">
<input type="text" name="ssid" placeholder="ssid の値" autocomplete="off" spellcheck="false">
<label class="note"><input type="checkbox" name="consent" value="1"> 上記リスクを理解し、自分のアカウントで自己責任で利用します</label><br>
<button type="submit">連携する</button>
</form></div>
<p class="note">このページのURLはあなた専用です。他人に見せないでください。</p>
</body></html>`
}
