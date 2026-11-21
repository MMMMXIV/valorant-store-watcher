import { useState } from 'react'
import type { Page } from '../App'
import { StoreSkinCard } from '../components/SkinCard'
import { IconAlert, IconRefresh } from '../components/Icons'
import { SkinImage } from '../components/SkinImage'
import { Badge, Button, Card, Notice, useToast } from '../components/ui'
import { api, errText } from '../lib/api'
import { fmtDate, fmtDateTime, fmtRelative, periodDay } from '../lib/format'
import { useData } from '../lib/store'

export function Dashboard({ go }: { go: (p: Page) => void }) {
  const { state, wishlist } = useData()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (!state) return null
  const s = state.settings
  const store = state.latestStore
  const matched = new Set(state.matchedSkinIds)
  const isRiot = state.provider.id === 'riot'
  const ready = state.provider.ready

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
  const login = async () => {
    setBusy(true)
    try {
      await api().riot.login()
      toast('ok', 'ログインしました')
    } catch (e) {
      toast('err', errText(e))
    } finally {
      setBusy(false)
    }
  }

  const monitorOn = state.schedulerRunning && s.autoCheckEnabled && ready
  // show the fetch error unless a newer successful store exists
  const err = state.fetchError && (!store || new Date(state.fetchError.at).getTime() > new Date(store.fetchedAt).getTime()) ? state.fetchError : null
  return (
    <div className="space-y-6">
      <PageHeader
        title="ダッシュボード"
        sub="DASHBOARD"
        right={
          <Button onClick={checkNow} busy={busy || state.checking} disabled={!ready}>
            <IconRefresh width={16} height={16} /> 今すぐチェック
          </Button>
        }
      />

      {state.provider.id === 'mock' && (
        <Notice tone="amber" title="テストモード：表示中のストアは疑似データです">
          取得方法が「テスト用ストア」になっています。実際のVALORANTストアではありません。
          自分のストアを取得するには <button className="underline" onClick={() => go('settings')}>設定 → ストア取得方法</button> で「Riotアカウント」を選んでください。
        </Notice>
      )}
      {state.update?.status === 'available' && (
        <Notice tone="teal" title={`新しいバージョン v${state.update.version} があります`}>
          <button className="underline" onClick={() => go('settings')}>設定 → アップデート</button> から更新できます。
        </Notice>
      )}

      <div className="grid grid-cols-4 gap-4">
        <Stat
          label="監視状態"
          value={state.checking ? 'チェック中' : monitorOn ? '監視中' : state.paused ? '一時停止' : !ready ? '要対応' : '自動チェックOFF'}
          tone={monitorOn ? 'teal' : !ready ? 'red' : 'mute'}
          sub={state.provider.name}
        />
        <Stat label="最終チェック" value={state.monitor.lastSuccessAt ? fmtDateTime(state.monitor.lastSuccessAt, s.timezone).slice(5) : '未実行'} sub={state.monitor.lastSuccessAt ? fmtRelative(state.monitor.lastSuccessAt) : '—'} />
        <Stat
          label="次回チェック予定"
          value={state.plan ? fmtDateTime(state.plan.dueAt, s.timezone).slice(5) : '—'}
          sub={state.plan ? `${fmtRelative(state.plan.dueAt)}・${planReason(state.plan.reason)}` : !ready ? '取得の準備ができていません' : '自動チェックが無効です'}
        />
        <Stat label="ウィッシュリスト一致" value={`${state.matchedSkinIds.length} / ${state.wishlistCount}`} tone={state.matchedSkinIds.length ? 'red' : 'mute'} sub={state.latestIsCurrent ? '本日のストア' : '最新の取得結果'} />
      </div>

      <Card
        title={
          <>
            {state.latestIsCurrent && !err ? '本日のストア' : '最新のストア'}
            {store && <span className="ml-2 normal-case tracking-normal text-mute/80">{fmtDate(periodDay(store), s.timezone)}</span>}
          </>
        }
        action={store && <span className="text-xs text-mute">取得 {fmtDateTime(store.fetchedAt, s.timezone)} ・ 更新 {store.periodEnd ? fmtDateTime(store.periodEnd, s.timezone) : '不明'}</span>}
      >
        {!ready ? (
          <StatusPanel
            title={isRiot ? (state.riot.needsRelogin ? 'Riotへの再ログインが必要です' : !s.riskAcknowledged ? 'Riotアカウント連携が未設定です' : 'Riotにログインしていません') : 'ストアを取得できません'}
            message={state.provider.status.message}
            actions={
              <>
                {isRiot && s.riskAcknowledged && (
                  <Button onClick={login} busy={busy}>
                    Riotにログイン
                  </Button>
                )}
                <Button variant="outline" onClick={() => go('settings')}>
                  設定を開く
                </Button>
              </>
            }
          />
        ) : err ? (
          <StatusPanel
            title="ストアを取得できませんでした"
            message={`${err.message ?? '不明なエラー'}（${fmtDateTime(err.at, s.timezone)}）`}
            sub={state.plan ? `次の自動再試行: ${fmtDateTime(state.plan.dueAt, s.timezone)}（${fmtRelative(state.plan.dueAt)}）` : undefined}
            actions={
              <>
                <Button onClick={checkNow} busy={busy || state.checking}>
                  <IconRefresh width={16} height={16} /> 再試行
                </Button>
                <Button variant="outline" onClick={() => go('history')}>
                  エラー履歴を見る
                </Button>
              </>
            }
          />
        ) : store ? (
          <div className="grid grid-cols-4 gap-4">
            {store.offers.map((o) => (
              <StoreSkinCard key={o.slot} slot={o.slot} skin={o.skin} price={o.price} matched={!!o.skinId && matched.has(o.skinId)} />
            ))}
          </div>
        ) : (
          <div className="py-12 text-center text-mute">まだストアを取得していません。「今すぐチェック」を押すと取得します。</div>
        )}
        {store && err && <p className="mt-4 text-xs text-amber">※ 前回取得できたストア（{fmtDate(periodDay(store), s.timezone)}）は「履歴」で確認できます。</p>}
        {store && !err && ready && !state.latestIsCurrent && <p className="mt-4 text-xs text-amber">※ このストアは更新期間を過ぎています。次回チェックで更新されます。</p>}
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
    </div>
  )
}

function StatusPanel({ title, message, sub, actions }: { title: string; message: string; sub?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 border border-crimson/50 bg-crimson/5 px-6 py-6">
      <IconAlert width={28} height={28} className="mt-0.5 shrink-0 text-crimson" />
      <div className="flex-1">
        <div className="text-lg font-bold">{title}</div>
        <div className="mt-1 text-sm text-bone/85">{message}</div>
        {sub && <div className="mt-1 text-xs text-mute">{sub}</div>}
        {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
      </div>
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
