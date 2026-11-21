import { useState } from 'react'
import { DataProvider, useData } from './lib/store'
import { IconCatalog, IconDashboard, IconHeart, IconHistory, IconLogo, IconSettings } from './components/Icons'
import { Dashboard } from './pages/Dashboard'
import { Catalog } from './pages/Catalog'
import { Wishlist } from './pages/Wishlist'
import { History } from './pages/History'
import { SettingsPage } from './pages/Settings'
import { fmtDateTime, fmtRelative } from './lib/format'

export type Page = 'dashboard' | 'catalog' | 'wishlist' | 'history' | 'settings'

const NAV: Array<{ id: Page; label: string; sub: string; icon: typeof IconDashboard }> = [
  { id: 'dashboard', label: 'ダッシュボード', sub: 'DASHBOARD', icon: IconDashboard },
  { id: 'catalog', label: 'スキンカタログ', sub: 'CATALOG', icon: IconCatalog },
  { id: 'wishlist', label: 'ウィッシュリスト', sub: 'WISHLIST', icon: IconHeart },
  { id: 'history', label: '履歴', sub: 'HISTORY', icon: IconHistory },
  { id: 'settings', label: '設定', sub: 'SETTINGS', icon: IconSettings }
]

export function App() {
  return (
    <DataProvider>
      <Shell />
    </DataProvider>
  )
}

function Shell() {
  const [page, setPage] = useState<Page>('dashboard')
  const { state, wishlist } = useData()
  return (
    <div className="grid-bg flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-ink-700 bg-ink-950/90">
        <div className="flex items-center gap-3 px-5 pb-6 pt-6">
          <IconLogo />
          <div className="leading-tight">
            <div className="display text-sm font-black text-bone">Store Watcher</div>
            <div className="text-[10px] tracking-widest text-mute">FOR VALORANT · 非公式</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {NAV.map((n) => {
            const active = page === n.id
            const Icon = n.icon
            return (
              <button
                key={n.id}
                onClick={() => setPage(n.id)}
                className={`group relative flex items-center gap-3 px-3 py-2.5 text-left transition ${active ? 'bg-crimson/10 text-bone' : 'text-mute hover:bg-ink-800 hover:text-bone'}`}
              >
                {active && <span className="absolute inset-y-0 left-0 w-[3px] bg-crimson" />}
                <Icon className={active ? 'text-crimson' : ''} />
                <span className="flex-1">
                  <span className="block text-sm font-semibold">{n.label}</span>
                  <span className="display block text-[9px] text-mute/70">{n.sub}</span>
                </span>
                {n.id === 'wishlist' && wishlist.length > 0 && <span className="text-xs text-mute">{wishlist.length}</span>}
              </button>
            )
          })}
        </nav>
        <MonitorFooter />
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] px-8 py-7">
          {!state ? (
            <div className="py-24 text-center text-mute">読み込み中…</div>
          ) : page === 'dashboard' ? (
            <Dashboard go={setPage} />
          ) : page === 'catalog' ? (
            <Catalog />
          ) : page === 'wishlist' ? (
            <Wishlist go={setPage} />
          ) : page === 'history' ? (
            <History />
          ) : (
            <SettingsPage />
          )}
        </div>
      </main>
    </div>
  )
}

function MonitorFooter() {
  const { state } = useData()
  if (!state) return null
  const active = state.schedulerRunning && state.settings.autoCheckEnabled && state.provider.supportsAutomatic
  return (
    <div className="m-3 border border-ink-700 bg-ink-900 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className={`relative inline-flex h-2.5 w-2.5 ${active ? 'bg-teal' : 'bg-ink-500'}`}>
          {active && <span className="absolute inset-0 animate-ping bg-teal/60" />}
        </span>
        <span className="font-semibold">{state.checking ? 'チェック中…' : active ? '監視中' : state.paused ? '一時停止中' : '自動監視オフ'}</span>
      </div>
      {active && state.plan && (
        <div className="mt-1.5 text-mute">
          次回 {fmtDateTime(state.plan.dueAt, state.settings.timezone)}
          <br />({fmtRelative(state.plan.dueAt)})
        </div>
      )}
      <div className="mt-2 text-[10px] text-ink-500">v{state.version}</div>
    </div>
  )
}
