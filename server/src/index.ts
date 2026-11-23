import http from 'node:http'
import path from 'node:path'
import {
  AppDatabase,
  CatalogService,
  ValorantApiClient,
  createRepos,
  nodeAuthorize,
  redact,
  type FetchLike
} from '../../src/core'
import { SecretBox } from './crypto'
import { SqliteUserStore } from './sqliteUserStore'
import { CommandService, type CommandName } from './commands'
import { ConnectService, connectPageHtml } from './connect'
import { COMMANDS, GatewayClient, INTERACTION_APPLICATION_COMMAND, interactionOptions, interactionUserId, registerCommands, respondInteraction, sendDm, type Interaction } from './discord'

/**
 * Server entry point (Oracle Cloud Always Free etc.).
 * Required env:
 *   VSW_SERVER_KEY   base64 32-byte key (keep SEPARATE from the DB)   → node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *   DISCORD_BOT_TOKEN, DISCORD_APP_ID
 *   PUBLIC_BASE_URL  e.g. https://your-host  (used in the /connect link)
 * Optional: DATA_DIR (default ./data), PORT (default 8080)
 */
const fetchImpl: FetchLike = (u, i) => fetch(u, i)
const log = (m: unknown): void => console.log(`[${new Date().toISOString()}] ${redact(m)}`)

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`環境変数 ${name} が未設定です`)
  return v
}

async function main(): Promise<void> {
  const key = requireEnv('VSW_SERVER_KEY')
  const botToken = requireEnv('DISCORD_BOT_TOKEN')
  const appId = requireEnv('DISCORD_APP_ID')
  const baseUrl = requireEnv('PUBLIC_BASE_URL').replace(/\/$/, '')
  const dataDir = process.env.DATA_DIR ?? path.resolve('data')
  const port = Number(process.env.PORT ?? 8080)

  const box = new SecretBox(key)
  const userStore = await SqliteUserStore.open(path.join(dataDir, 'users.sqlite'))

  // catalog (own DB), refreshed on startup and daily
  const catalogDb = await AppDatabase.open(path.join(dataDir, 'catalog.sqlite'))
  const repos = createRepos(catalogDb)
  const catalogService = new CatalogService(repos.catalog, repos.meta, new ValorantApiClient(fetchImpl))
  const refreshCatalog = async (): Promise<void> => {
    try {
      if (catalogService.isStale(24) || repos.catalog.count() === 0) {
        const st = await catalogService.update(false)
        log(`カタログ更新: ${st.skinCount} スキン`)
      }
    } catch (e) {
      log(`カタログ更新失敗: ${redact(e)}`)
    }
  }
  await refreshCatalog()
  setInterval(() => void refreshCatalog(), 6 * 3600_000)

  const getClientVersion = () => catalogService.fetchVersion().then((v) => v.riotClientVersion)
  const authorize = nodeAuthorize(fetchImpl)
  const commands = new CommandService({ userStore, box, catalog: repos.catalog, fetchImpl, authorize, getClientVersion, timezone: 'Asia/Tokyo' })
  const connect = new ConnectService({ userStore, box, fetchImpl, authorize, getClientVersion })

  // --- Discord slash commands over the gateway ---
  await registerCommands(fetchImpl, appId, botToken)
  log(`コマンド登録: ${COMMANDS.map((c) => c.name).join(', ')}`)
  const gateway = new GatewayClient(botToken, (i: Interaction) => void handleInteraction(i), log)
  gateway.start()

  async function handleInteraction(i: Interaction): Promise<void> {
    if (i.type !== INTERACTION_APPLICATION_COMMAND || !i.data) return
    const userId = interactionUserId(i)
    if (!userId) return
    const name = i.data.name
    try {
      if (name === 'connect') {
        const token = connect.createLink(userId)
        await respondInteraction(fetchImpl, i, { content: '連携ページのリンクをDMに送りました。', flags: 64 })
        await sendDm(fetchImpl, botToken, userId, `Riotアカウント連携はこちら（あなた専用・30分有効）:\n${baseUrl}/connect/${token}`).catch(async () => {
          await respondInteraction(fetchImpl, i, { content: `DMを送れませんでした。連携URL: ${baseUrl}/connect/${token}`, flags: 64 })
        })
        return
      }
      const reply = await commands.handle(userId, name as CommandName, interactionOptions(i))
      await respondInteraction(fetchImpl, i, { ...reply.payload, flags: reply.ephemeral ? 64 : 0 } as never)
    } catch (e) {
      log(`interaction ${name} failed: ${redact(e)}`)
      await respondInteraction(fetchImpl, i, { content: 'エラーが発生しました。しばらくして再度お試しください。', flags: 64 }).catch(() => undefined)
    }
  }

  // --- /connect web pages ---
  const server = http.createServer((req, res) => void handleHttp(req, res))
  server.listen(port, () => log(`HTTP listening on :${port} (base ${baseUrl})`))

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', baseUrl)
    const send = (code: number, type: string, body: string): void => {
      res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
      res.end(body)
    }
    try {
      if (req.method === 'GET' && url.pathname.startsWith('/connect/')) {
        const token = url.pathname.slice('/connect/'.length)
        if (!connect.tokenValid(token)) return send(410, 'text/html; charset=utf-8', connectPageHtml('', 'リンクの有効期限が切れています。Discordで /connect をやり直してください。'))
        return send(200, 'text/html; charset=utf-8', connectPageHtml(token))
      }
      if (req.method === 'POST' && url.pathname === '/connect/submit') {
        const body = await readBody(req)
        const form = new URLSearchParams(body)
        const token = form.get('token') ?? ''
        const r = await connect.submit(token, { consent: form.get('consent') === '1', ssid: form.get('ssid') ?? '' })
        return send(r.ok ? 200 : 400, 'text/html; charset=utf-8', connectPageHtml(r.ok ? '' : token, r.message))
      }
      if (url.pathname === '/health') return send(200, 'text/plain', 'ok')
      send(404, 'text/plain', 'not found')
    } catch (e) {
      log(`http error: ${redact(e)}`)
      send(500, 'text/plain', 'error')
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 100_000) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

main().catch((e) => {
  console.error(redact(e))
  process.exit(1)
})
