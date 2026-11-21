import { useMemo, useState } from 'react'
import type { Page } from '../App'
import { StoreSkinCard } from '../components/SkinCard'
import { IconAlert, IconRefresh, IconPlus, IconSearch, IconX } from '../components/Icons'
import { SkinImage } from '../components/SkinImage'
import { Badge, Button, Card, Modal, Notice, inputCls, useToast } from '../components/ui'
import { api, errText, type CatalogSkin } from '../lib/api'
import { fmtDate, fmtDateTime, fmtRelative, periodDay } from '../lib/format'
import { useData } from '../lib/store'
import { searchSkinsUi } from '../lib/search'

export function Dashboard({ go }: { go: (p: Page) => void }) {
  const { state, wishlist } = useData()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  if (!state) return null
  const s = state.settings
  const store = state.latestStore
  const matched = new Set(state.matchedSkinIds)
  const auto = state.provider.supportsAutomatic

  const checkNow = async () => {
    setBusy(true)
    try {
      const r = await api().store.checkNow()
      toast(r.status === 'success' ? 'ok' : 'err', r.message)
    } catch (e) {
      toast('err', errText(e))
    } finally {
      setBusy(false)
    }
  }

  const monitorOn = state.schedulerRunning && s.autoCheckEnabled && auto
  return (
    <div className="space-y-6">
      <PageHeader
        title="ダッシュボード"
        sub="DASHBOARD"
        right={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <IconPlus width={16} height={16} /> ストアを手動入力
            </Button>
            {auto && (
              <Button onClick={checkNow} busy={busy || state.checking}>
                <IconRefresh width={16} height={16} /> 今すぐチェック
              </Button>
            )}
          </div>
        }
      />

      {state.provider.id === 'mock' && (
        <Notice tone="amber" title="テストモード：表示中のストアは疑似データです">
          現在の取得方法は「テスト用ストア（Mock）」です。実際のVALORANTストアではありません。通知の流れを確認する用途に使えます。
          取得方法は <button className="underline" onClick={() => go('settings')}>設定</button> で変更できます。
        </Notice>
      )}
      {state.monitor.lastError && (
        <Notice tone="red" title="最後のチェックでエラーが発生しました">
          {state.monitor.lastError}（{fmtDateTime(state.monitor.lastErrorAt, s.timezone)}）
        </Notice>
      )}

      <div className="grid grid-cols-4 gap-4">
        <Stat label="監視状態" value={state.checking ? 'チェック中' : monitorOn ? '監視中' : state.paused ? '一時停止' : auto ? '自動チェックOFF' : '手動モード'} tone={monitorOn ? 'teal' : 'mute'} sub={state.provider.name} />
        <Stat label="最終チェック" value={state.monitor.lastSuccessAt ? fmtDateTime(state.monitor.lastSuccessAt, s.timezone).slice(5) : '未実行'} sub={state.monitor.lastSuccessAt ? fmtRelative(state.monitor.lastSuccessAt) : '—'} />
        <Stat
          label="次回チェック予定"
          value={state.plan ? fmtDateTime(state.plan.dueAt, s.timezone).slice(5) : '—'}
          sub={state.plan ? `${fmtRelative(state.plan.dueAt)}・${planReason(state.plan.reason)}` : auto ? '自動チェックが無効です' : '手動取り込みモード'}
        />
        <Stat label="ウィッシュリスト一致" value={`${state.matchedSkinIds.length} / ${state.wishlistCount}`} tone={state.matchedSkinIds.length ? 'red' : 'mute'} sub={state.latestIsCurrent ? '本日のストア' : '最新の取得結果'} />
      </div>

      <Card
        title={
          <>
            {state.latestIsCurrent ? '本日のストア' : '最新のストア'}
            {store && <span className="ml-2 normal-case tracking-normal text-mute/80">{fmtDate(periodDay(store), s.timezone)}</span>}
          </>
        }
        action={store && <span className="text-xs text-mute">取得 {fmtDateTime(store.fetchedAt, s.timezone)} ・ 更新 {store.periodEnd ? fmtDateTime(store.periodEnd, s.timezone) : '不明'}</span>}
      >
        {store ? (
          <div className="grid grid-cols-4 gap-4">
            {store.offers.map((o) => (
              <StoreSkinCard key={o.slot} slot={o.slot} skin={o.skin} price={o.price} matched={!!o.skinId && matched.has(o.skinId)} />
            ))}
          </div>
        ) : (
          <div className="py-12 text-center text-mute">
            まだストア情報がありません。{auto ? '「今すぐチェック」を押すか、' : ''}「ストアを手動入力」から取り込んでください。
          </div>
        )}
        {store && !state.latestIsCurrent && <p className="mt-4 text-xs text-amber">※ このストアは更新期間を過ぎています。次回チェックで更新されます。</p>}
      </Card>

      <div className="grid grid-cols-3 gap-4">
        <Card title="ウィッシュリスト一致状況" className="col-span-2" action={<button className="text-xs text-mute hover:text-bone" onClick={() => go('wishlist')}>すべて表示 →</button>}>
          {wishlist.length === 0 ? (
            <div className="py-6 text-center text-sm text-mute">
              ウィッシュリストが空です。<button className="text-crimson underline" onClick={() => go('catalog')}>スキンカタログ</button>から追加しましょう。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {wishlist.slice(0, 8).map((w) => (
                <div key={w.skinId} className={`flex items-center gap-3 border px-3 py-2 ${matched.has(w.skinId) ? 'border-crimson/70 bg-crimson/5' : 'border-ink-700'}`}>
                  <SkinImage skin={w.skin} className="h-8 w-16" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{w.skin?.nameJa ?? w.skinId}</div>
                    <div className="text-[11px] text-mute">{w.skin?.weaponNameJa}</div>
                  </div>
                  {matched.has(w.skinId) ? <Badge tone="red">販売中</Badge> : <Badge tone="mute">未登場</Badge>}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="通知とローカル実行について">
          <ul className="space-y-2 text-xs leading-relaxed text-bone/80">
            <li>
              Discord通知: {state.webhookConfigured ? <Badge tone="teal">設定済み</Badge> : <Badge tone="amber">未設定</Badge>}
              {!s.notificationsEnabled && <Badge tone="mute" className="ml-1">通知OFF</Badge>}
            </li>
            <li className="flex gap-2">
              <IconAlert width={14} height={14} className="mt-0.5 shrink-0 text-amber" />
              <span>このアプリはPC上で動作します。<b>PCの電源が切れている・スリープ中は監視できません。</b>起動・復帰時に未確認のストアがあれば自動で確認します。</span>
            </li>
            <li>ウィンドウを閉じてもタスクトレイで監視を続けます。</li>
          </ul>
        </Card>
      </div>
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}

function planReason(r: string): string {
  return { 'source-refresh': 'ストア更新時刻ベース', scheduled: '設定時刻', 'catch-up': '未確認分をすぐ確認', retry: '再試行', 'after-retries': '再試行上限→次の定時' }[r] ?? r
}

export function PageHeader({ title, sub, right }: { title: string; sub: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between">
      <div>
        <div className="display text-[11px] font-bold text-crimson">{sub}</div>
        <h1 className="mt-1 text-3xl font-black tracking-tight">{title}</h1>
      </div>
      {right}
    </div>
  )
}

function Stat({ label, value, sub, tone = 'default' }: { label: string; value: string; sub?: string; tone?: 'default' | 'teal' | 'red' | 'mute' }) {
  const c = { default: 'text-bone', teal: 'text-teal', red: 'text-crimson', mute: 'text-bone' }[tone]
  return (
    <div className="clip-corner relative border border-ink-700 bg-ink-850 px-5 py-4">
      <div className="display text-[10px] font-bold text-mute">{label}</div>
      <div className={`mt-1.5 truncate text-2xl font-black ${c}`}>{value}</div>
      {sub && <div className="mt-1 truncate text-xs text-mute">{sub}</div>}
    </div>
  )
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { skins } = useData()
  const toast = useToast()
  const [tab, setTab] = useState<'pick' | 'json'>('pick')
  const [q, setQ] = useState('')
  const [picks, setPicks] = useState<Array<{ skin: CatalogSkin; price: string }>>([])
  const [json, setJson] = useState('')
  const [busy, setBusy] = useState(false)
  const results = useMemo(() => (q.trim() ? searchSkinsUi(skins, q, null).slice(0, 12) : []), [skins, q])

  const submit = async () => {
    setBusy(true)
    try {
      const r =
        tab === 'pick'
          ? await api().store.importPicked(picks.map((p) => ({ skinId: p.skin.id, price: p.price ? Number(p.price) : null })))
          : await api().store.importJson(json)
      toast(r.status === 'success' ? 'ok' : 'err', r.message)
      if (r.status === 'success') {
        setPicks([])
        setJson('')
        onClose()
      }
    } catch (e) {
      toast('err', errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="ストアを手動入力" wide>
      <div className="mb-4 flex gap-1">
        {(['pick', 'json'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-semibold ${tab === t ? 'bg-crimson text-white' : 'bg-ink-800 text-mute hover:text-bone'}`}>
            {t === 'pick' ? 'スキンを選んで入力' : 'JSONを貼り付け'}
          </button>
        ))}
      </div>
      {tab === 'pick' ? (
        <div className="space-y-4">
          <p className="text-xs text-mute">ゲーム内のストアに並んでいるスキンを最大4つ選び、価格を入力してください。今日のストアとして記録・照合されます。</p>
          <div className="relative">
            <IconSearch className="absolute left-3 top-2.5 text-mute" />
            <input className={`${inputCls} pl-10`} placeholder="スキン名で検索（日本語・英語）" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {results.length > 0 && (
            <div className="grid max-h-48 grid-cols-2 gap-1 overflow-auto">
              {results.map((s) => (
                <button
                  key={s.id}
                  disabled={picks.length >= 4 || picks.some((p) => p.skin.id === s.id)}
                  onClick={() => {
                    setPicks([...picks, { skin: s, price: '' }])
                    setQ('')
                  }}
                  className="flex items-center gap-2 bg-ink-800 px-2 py-1.5 text-left text-sm hover:bg-ink-700 disabled:opacity-40"
                >
                  <SkinImage skin={s} className="h-6 w-12" />
                  <span className="truncate">{s.nameJa}</span>
                </button>
              ))}
            </div>
          )}
          <div className="space-y-2">
            {picks.map((p, i) => (
              <div key={p.skin.id} className="flex items-center gap-3 border border-ink-700 px-3 py-2">
                <SkinImage skin={p.skin} className="h-8 w-16" />
                <span className="flex-1 truncate text-sm font-semibold">{p.skin.nameJa}</span>
                <input
                  className={`${inputCls} max-w-28`}
                  placeholder="VP"
                  inputMode="numeric"
                  value={p.price}
                  onChange={(e) => setPicks(picks.map((x, j) => (j === i ? { ...x, price: e.target.value.replace(/\D/g, '').slice(0, 6) } : x)))}
                />
                <button className="text-mute hover:text-crimson" onClick={() => setPicks(picks.filter((_, j) => j !== i))} aria-label="削除">
                  <IconX />
                </button>
              </div>
            ))}
            {!picks.length && <div className="py-4 text-center text-xs text-ink-500">まだ選択されていません</div>}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-mute">
            <code>vsw-store-v1</code> 形式、またはストアAPI形式（<code>SkinsPanelLayout</code> を含むJSON）に対応しています。詳しくはREADMEを参照してください。
          </p>
          <textarea
            className={`${inputCls} h-56 font-mono text-xs`}
            placeholder={'{\n  "format": "vsw-store-v1",\n  "date": "2026-11-21",\n  "offers": [ { "id": "スキンまたはレベルのUUID", "price": 1775 } ]\n}'}
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
        </div>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          キャンセル
        </Button>
        <Button onClick={submit} busy={busy} disabled={tab === 'pick' ? !picks.length : json.trim().length < 2}>
          取り込んで照合する
        </Button>
      </div>
    </Modal>
  )
}
