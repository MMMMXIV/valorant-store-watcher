/**
 * Headless runner — the same monitoring core without Electron/UI.
 * Demonstrates that the watcher can move to a server / scheduled task later.
 *
 *   npm run headless -- --once                 # one check with the configured provider
 *   npm run headless -- --import store.json    # import a store JSON, match & notify
 *   npm run headless -- --daemon               # keep running with the scheduler
 *   npm run headless -- --set checkTime=09:10
 *
 * Env: VSW_DB_PATH (default ./vsw-headless.sqlite), VSW_DISCORD_WEBHOOK (secret; never commit)
 */
import fs from 'node:fs'
import path from 'node:path'
import { WatcherCore, isValidWebhookUrl, parseStoreImport, redact, SettingsPatchSchema, formatZonedDateTime } from '../core'

function loadDotEnv(): void {
  const p = path.resolve('.env')
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

async function main(): Promise<void> {
  loadDotEnv()
  const args = process.argv.slice(2)
  const flag = (n: string) => args.includes(n)
  const val = (n: string) => {
    const i = args.indexOf(n)
    return i >= 0 ? args[i + 1] : undefined
  }
  const webhook = process.env.VSW_DISCORD_WEBHOOK?.trim() || null
  if (webhook && !isValidWebhookUrl(webhook)) throw new Error('VSW_DISCORD_WEBHOOK の形式が不正です')

  const core = await WatcherCore.create({
    dbPath: path.resolve(process.env.VSW_DB_PATH ?? 'vsw-headless.sqlite'),
    fetchImpl: (u, i) => fetch(u, i),
    getWebhookUrl: async () => webhook
  })
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${redact(m)}`)

  // --set key=value (JSON values allowed)
  const sets: Record<string, unknown> = {}
  args.forEach((a, i) => {
    if (a === '--set' && args[i + 1]) {
      const [k, ...rest] = args[i + 1].split('=')
      const v = rest.join('=')
      try {
        sets[k] = JSON.parse(v)
      } catch {
        sets[k] = v
      }
    }
  })
  if (Object.keys(sets).length) {
    core.repos.settings.update(SettingsPatchSchema.parse(sets))
    log(`設定を更新: ${Object.keys(sets).join(', ')}`)
  }

  if (core.catalogService.isStale(24) || flag('--update-catalog')) {
    log('カタログを更新中…')
    const st = await core.catalogService.update(flag('--update-catalog'))
    log(`カタログ: ${st.skinCount} スキン`)
  }
  for (const id of (val('--wish') ?? '').split(',').filter(Boolean)) {
    const w = core.repos.wishlist.add(id)
    log(`ウィッシュリストに追加: ${w.skin?.nameJa ?? w.skinId}`)
  }

  const importFile = val('--import')
  if (importFile) {
    const r = await core.checkService.runCheck('headless', parseStoreImport(fs.readFileSync(importFile, 'utf8'), new Date(), 'headless-import'))
    log(`${r.status}: ${r.message}`)
  } else if (flag('--once')) {
    const r = await core.checkService.runCheck('headless')
    log(`${r.status}: ${r.message}`)
  } else if (flag('--daemon')) {
    log(`監視を開始します（取得方法: ${core.provider.displayName}）`)
    core.scheduler.start()
    const report = () => {
      const p = core.scheduler.plan()
      log(p ? `次回チェック: ${formatZonedDateTime(p.dueAt, core.repos.settings.get().timezone)} (${p.reason})` : '自動チェック対象外の設定です')
    }
    report()
    setInterval(report, 3600_000)
    const stop = () => {
      log('終了します')
      core.close()
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return
  } else {
    const st = core.repos.monitor.get()
    log(`最終成功: ${st.lastSuccessAt ?? '—'} / 最終エラー: ${st.lastError ?? '—'} / ウィッシュリスト ${core.repos.wishlist.list().length}件`)
    log('使い方: --once | --import <file> | --daemon | --wish <skinId,...> | --set key=value | --update-catalog')
  }
  core.close()
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? e.message : String(e)))
  process.exit(1)
})
