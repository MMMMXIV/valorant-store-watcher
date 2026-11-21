import { useEffect, useState } from 'react'
import { Badge, Button, Card, Notice, Toggle, inputCls, useToast } from '../components/ui'
import { api, errText, type Diagnostics, type Settings } from '../lib/api'
import { fmtDateTime } from '../lib/format'
import { useData } from '../lib/store'
import { PageHeader } from './Dashboard'

const TIMEZONES = ['Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC']

export function SettingsPage() {
  const { state } = useData()
  const toast = useToast()
  if (!state) return null
  const s = state.settings
  const save = async (patch: Partial<Settings>, msg = '設定を保存しました') => {
    try {
      await api().settings.update(patch)
      toast('ok', msg)
    } catch (e) {
      toast('err', errText(e))
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="設定" sub="SETTINGS" />
      <div className="grid grid-cols-2 gap-5">
        <div className="space-y-5">
          <RiotCard />
          <ProviderCard s={s} save={save} />
          <ScheduleCard s={s} save={save} />
        </div>
        <div className="space-y-5">
          <WebhookCard />
          <NotifyCard s={s} save={save} />
          <WindowsCard s={s} save={save} />
          <CatalogCard />
        </div>
      </div>
      <DiagnosticsCard />
    </div>
  )
}

type SaveFn = (patch: Partial<Settings>, msg?: string) => Promise<void>

function RiotCard() {
  return (
    <Card title="Riotアカウント連携">
      <div className="mb-3 flex items-center gap-2">
        <Badge tone="mute">未連携</Badge>
        <span className="text-sm">このアプリはRiotアカウントにログインしません</span>
      </div>
      <Notice tone="mute">
        Riot Games の公式APIは<strong>個人別のデイリーストアを提供しておらず</strong>、ストア監視は公式APIの未承認用途とされています。
        非公式な方法（パスワードやログインCookieを使う方法）は規約違反やアカウント停止のリスクがあるため、本アプリは標準では搭載していません。
        Riotのパスワードを本アプリに入力することはありません。
        <div className="mt-2">
          <button className="text-crimson underline" onClick={() => void api().openExternal('https://developer.riotgames.com/docs/valorant')}>
            Riot Developer Portal（VALORANT）を開く
          </button>
        </div>
      </Notice>
    </Card>
  )
}

function ProviderCard({ s, save }: { s: Settings; save: SaveFn }) {
  const { state } = useData()
  const opts: Array<{ id: Settings['providerId']; title: string; desc: string }> = [
    { id: 'mock', title: 'テスト用ストア（Mock）', desc: 'カタログから毎日ランダムな4スキンを生成します。通知の動作確認用。自動チェック対応。' },
    { id: 'manual', title: '手動取り込み', desc: 'ゲーム内で見たストアをダッシュボードから入力・貼り付け。自動チェックなし。' },
    { id: 'manual-file', title: 'JSONファイル監視', desc: '指定したJSONファイルを定時に読み込みます。ファイルは自分で用意します（形式はREADME参照）。自動チェック対応。' }
  ]
  const pick = async () => {
    const p = await api().pickJsonFile()
    if (p) await save({ manualFilePath: p }, 'ファイルを設定しました')
  }
  return (
    <Card title="ストア取得方法">
      <div className="space-y-2">
        {opts.map((o) => (
          <label key={o.id} className={`flex cursor-pointer gap-3 border px-4 py-3 ${s.providerId === o.id ? 'border-crimson bg-crimson/5' : 'border-ink-700 hover:border-ink-500'}`}>
            <input type="radio" className="mt-1 accent-[#ff4655]" checked={s.providerId === o.id} onChange={() => void save({ providerId: o.id }, '取得方法を変更しました')} />
            <span>
              <span className="block text-sm font-bold">{o.title}</span>
              <span className="block text-xs text-mute">{o.desc}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 text-xs text-mute">
        状態: <span className={state?.provider.status.ready ? 'text-teal' : 'text-amber'}>{state?.provider.status.message}</span>
      </div>
      {s.providerId === 'mock' && (
        <div className="mt-3 border-t border-ink-700 pt-2">
          <Toggle
            checked={s.mockForceWishlistHit}
            onChange={(v) => void save({ mockForceWishlistHit: v })}
            label="ウィッシュリストのスキンを必ず含める（動作確認用）"
            description="最優先のウィッシュリストスキンが毎日のテスト用ストアに必ず登場します。"
          />
        </div>
      )}
      {s.providerId === 'manual-file' && (
        <div className="mt-3 flex items-center gap-2">
          <input className={inputCls} readOnly value={s.manualFilePath ?? ''} placeholder="ファイル未選択" />
          <Button variant="outline" onClick={() => void pick()}>
            選択
          </Button>
        </div>
      )}
    </Card>
  )
}

function ScheduleCard({ s, save }: { s: Settings; save: SaveFn }) {
  const { state } = useData()
  const [time, setTime] = useState(s.checkTime)
  const [delay, setDelay] = useState(String(s.checkDelayMinutes))
  useEffect(() => setTime(s.checkTime), [s.checkTime])
  return (
    <Card title="自動チェック">
      <Toggle checked={s.autoCheckEnabled} onChange={(v) => void save({ autoCheckEnabled: v })} label="自動チェックを有効にする" disabled={!state?.provider.supportsAutomatic} description={!state?.provider.supportsAutomatic ? '現在の取得方法は自動チェックに対応していません' : undefined} />
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="text-xs text-mute">
          チェック時刻（毎日）
          <input type="time" className={`${inputCls} mt-1`} value={time} onChange={(e) => setTime(e.target.value)} onBlur={() => time !== s.checkTime && /^\d\d:\d\d$/.test(time) && void save({ checkTime: time })} />
        </label>
        <label className="text-xs text-mute">
          タイムゾーン
          <select className={`${inputCls} mt-1`} value={s.timezone} onChange={(e) => void save({ timezone: e.target.value })}>
            {TIMEZONES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-mute">
          ストア更新後の待ち時間（分）
          <input className={`${inputCls} mt-1`} inputMode="numeric" value={delay} onChange={(e) => setDelay(e.target.value.replace(/\D/g, '').slice(0, 3))} onBlur={() => void save({ checkDelayMinutes: Math.min(180, Number(delay || 0)) })} />
        </label>
        <div className="text-xs text-mute">
          失敗時の再試行
          <div className="mt-2 text-bone">{s.retryMinutes.join(' → ')} 分後</div>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-mute">
        取得元がストアの更新時刻を返す場合はそれを優先し、更新の{s.checkDelayMinutes}分後にチェックします。分からない場合は上の時刻に毎日チェックします（標準 9:05 / 日本時間）。
        同じストア期間に何度チェックしても通知は1回だけです。
      </p>
      <Notice tone="amber">PCの電源が切れている間やスリープ中はチェックできません。次にPCを起動・復帰したとき、未確認のストアがあればすぐに確認します。</Notice>
      {state?.plan && <div className="mt-3 text-xs">次回予定: {fmtDateTime(state.plan.dueAt, s.timezone)}</div>}
    </Card>
  )
}

function WebhookCard() {
  const { state } = useData()
  const toast = useToast()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (k: string, fn: () => Promise<void>) => {
    setBusy(k)
    try {
      await fn()
    } catch (e) {
      toast('err', errText(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Card title="Discord Webhook" action={state?.webhookConfigured ? <Badge tone="teal">設定済み（暗号化保存）</Badge> : <Badge tone="amber">未設定</Badge>}>
      <input type="password" autoComplete="off" spellCheck={false} className={inputCls} placeholder={state?.webhookConfigured ? '新しいURLを入力すると上書きします' : 'https://discord.com/api/webhooks/...'} value={url} onChange={(e) => setUrl(e.target.value)} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          busy={busy === 'save'}
          disabled={!url.trim()}
          onClick={() =>
            void run('save', async () => {
              await api().webhook.set(url.trim())
              setUrl('')
              toast('ok', 'Webhook URLを暗号化して保存しました')
            })
          }
        >
          保存
        </Button>
        <Button
          variant="outline"
          busy={busy === 'test'}
          disabled={!url.trim() && !state?.webhookConfigured}
          onClick={() =>
            void run('test', async () => {
              const r = await api().webhook.test(url.trim() || undefined)
              toast(r.ok ? 'ok' : 'err', r.message)
            })
          }
        >
          テスト通知
        </Button>
        {state?.webhookConfigured && (
          <Button
            variant="danger"
            busy={busy === 'clear'}
            onClick={() =>
              void run('clear', async () => {
                await api().webhook.clear()
                toast('info', 'Webhook URLを削除しました')
              })
            }
          >
            削除
          </Button>
        )}
      </div>
      {!state?.secureStorageAvailable && <div className="mt-3"><Notice tone="red">OSの暗号化機能が利用できないため、Webhook URLを保存できません。</Notice></div>}
      <p className="mt-3 text-xs leading-relaxed text-mute">
        Webhook URLはWindowsの資格情報保護機能（DPAPI）で暗号化して保存され、画面には表示されません。URLは他人に教えないでください（知っている人は誰でもそのチャンネルに投稿できます）。
        作成方法: Discordのチャンネル設定 → 連携サービス → ウェブフック → 新しいウェブフック → URLをコピー。
      </p>
    </Card>
  )
}

function NotifyCard({ s, save }: { s: Settings; save: SaveFn }) {
  return (
    <Card title="通知条件">
      <Toggle checked={s.notificationsEnabled} onChange={(v) => void save({ notificationsEnabled: v })} label="Discord通知を有効にする" description="OFFにするとすべての通知を停止します（ストアの取得・記録は続きます）" />
      <div className={`border-t border-ink-700 ${s.notificationsEnabled ? '' : 'pointer-events-none opacity-40'}`}>
        <Toggle checked={s.notifyWishlist} onChange={(v) => void save({ notifyWishlist: v })} label="ウィッシュリスト一致時に通知" description="登録スキンがストアに登場したら画像付きで通知（推奨）" />
        <Toggle checked={s.notifyDailyStore} onChange={(v) => void save({ notifyDailyStore: v })} label="毎日のストア全体を通知" description="一致の有無に関わらず、その日の4スキンを毎日1回通知" />
        <Toggle checked={s.notifyErrors} onChange={(v) => void save({ notifyErrors: v })} label="エラー発生時に通知" description="ストア取得に失敗したとき（1日1回まで）" />
      </div>
    </Card>
  )
}

function WindowsCard({ s, save }: { s: Settings; save: SaveFn }) {
  return (
    <Card title="Windows">
      <Toggle checked={s.launchAtLogin} onChange={(v) => void save({ launchAtLogin: v })} label="Windowsログイン時に自動起動" description="ログイン時にトレイで起動し、監視を始めます" />
      <Toggle checked={s.startHidden} onChange={(v) => void save({ startHidden: v })} label="自動起動時はウィンドウを表示しない" />
      <Toggle checked={s.closeToTray} onChange={(v) => void save({ closeToTray: v })} label="ウィンドウを閉じてもトレイで監視を続ける" description="完全に終了するにはトレイアイコンを右クリック →「終了」" />
    </Card>
  )
}

function CatalogCard() {
  const { state } = useData()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <Card title="スキンデータ">
      <div className="text-sm">
        {state?.catalog.skinCount ?? 0} スキン・最終更新 {fmtDateTime(state?.catalog.updatedAt)}
        <div className="text-xs text-mute">ゲームバージョン: {state?.catalog.version?.split('|')[0] ?? '—'}</div>
      </div>
      <p className="mt-2 text-xs text-mute">ゲームのバージョンが変わると自動で新しいスキンを取り込みます（起動時と6時間ごとに確認）。データ提供: Valorant-API（非公式・有志運営）</p>
      <Button
        className="mt-3"
        variant="outline"
        busy={busy}
        onClick={async () => {
          setBusy(true)
          try {
            const r = await api().catalog.update(true)
            toast('ok', `更新しました（${r.skinCount}スキン）`)
          } catch (e) {
            toast('err', errText(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        今すぐ更新
      </Button>
    </Card>
  )
}

function DiagnosticsCard() {
  const [d, setD] = useState<Diagnostics | null>(null)
  const { state } = useData()
  return (
    <Card title="診断・ログ" action={<div className="flex gap-2"><Button variant="outline" onClick={() => void api().diagnostics().then(setD)}>診断情報を表示</Button><Button variant="ghost" onClick={() => void api().openLogs()}>ログフォルダを開く</Button></div>}>
      <div className="grid grid-cols-4 gap-3 text-xs">
        <Info k="アプリ" v={`v${state?.version}`} />
        <Info k="監視" v={state?.schedulerRunning ? '稼働中' : '停止中'} />
        <Info k="最終成功" v={fmtDateTime(state?.monitor.lastSuccessAt)} />
        <Info k="連続失敗" v={`${state?.monitor.consecutiveFailures ?? 0} 回`} />
      </div>
      {state?.monitor.lastError && <div className="mt-3 text-xs text-crimson">最終エラー: {state.monitor.lastError}</div>}
      {d && (
        <div className="mt-4 space-y-2">
          <div className="grid grid-cols-4 gap-3 text-xs">
            <Info k="Electron" v={d.electron} />
            <Info k="OS" v={d.platform} />
            <Info k="DBスキーマ" v={String(d.dbSchema)} />
            <Info k="自動起動登録" v={d.loginItem ? 'あり' : 'なし'} />
          </div>
          <div className="text-xs text-mute">データ保存先: {d.userData}</div>
          <pre className="max-h-72 overflow-auto bg-ink-950 p-3 text-[11px] leading-relaxed text-bone/80">{d.logs || '(ログなし)'}</pre>
          <p className="text-[11px] text-mute">※ ログにはWebhook URLやトークンなどの秘密情報は記録されません（自動でマスクされます）。</p>
        </div>
      )}
    </Card>
  )
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="border border-ink-700 px-3 py-2">
      <div className="text-mute">{k}</div>
      <div className="mt-0.5 font-semibold">{v}</div>
    </div>
  )
}
