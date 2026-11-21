import { useEffect, useState } from 'react'
import { SkinImage } from '../components/SkinImage'
import { Badge, Card } from '../components/ui'
import { api, type HistoryData } from '../lib/api'
import { fmtDate, fmtDateTime, fmtVp, periodDay } from '../lib/format'
import { useData } from '../lib/store'
import { PageHeader } from './Dashboard'

type Tab = 'stores' | 'skins' | 'notifications' | 'runs' | 'errors'
const TABS: Array<[Tab, string]> = [
  ['stores', 'ストア取得履歴'],
  ['skins', '過去の出現スキン'],
  ['notifications', 'Discord通知履歴'],
  ['runs', 'チェック履歴'],
  ['errors', 'エラー履歴']
]
const KIND: Record<string, string> = { wishlist: 'ウィッシュリスト', daily: '全ストア', error: 'エラー', test: 'テスト' }
const TRIGGER: Record<string, string> = { auto: '自動', manual: '手動', startup: '起動時', retry: '再試行', import: '取り込み', headless: 'ヘッドレス' }

export function History() {
  const { state, wishIds } = useData()
  const [tab, setTab] = useState<Tab>('stores')
  const [data, setData] = useState<HistoryData | null>(null)
  const tz = state?.settings.timezone ?? 'Asia/Tokyo'
  const stamp = `${state?.lastRun?.id}|${state?.lastRun?.status}|${state?.monitor.lastAttemptAt}`
  useEffect(() => {
    void api().history().then(setData)
  }, [stamp])

  return (
    <div className="space-y-5">
      <PageHeader title="履歴" sub="HISTORY" />
      <div className="flex gap-1 border-b border-ink-700">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold ${tab === id ? 'border-crimson text-bone' : 'border-transparent text-mute hover:text-bone'}`}>
            {label}
          </button>
        ))}
      </div>
      {!data ? (
        <div className="py-10 text-center text-mute">読み込み中…</div>
      ) : tab === 'stores' ? (
        <div className="space-y-3">
          {data.snapshots.length === 0 && <Empty />}
          {data.snapshots.map((s) => (
            <Card key={s.id} title={`${fmtDate(periodDay(s), tz)} のストア`} action={<span className="text-xs text-mute">{s.accountName ?? s.accountId}・{s.source}・取得 {fmtDateTime(s.fetchedAt, tz)}</span>}>
              <div className="grid grid-cols-4 gap-3">
                {s.offers.map((o) => (
                  <div key={o.slot} className={`flex items-center gap-3 border px-3 py-2 ${o.skinId && wishIds.has(o.skinId) ? 'border-crimson/70' : 'border-ink-700'}`}>
                    <SkinImage skin={o.skin} className="h-10 w-20" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{o.skin?.nameJa ?? '不明'}</div>
                      <div className="text-xs text-mute">{fmtVp(o.price)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      ) : tab === 'skins' ? (
        <Table head={['スキン', '武器', '出現回数', '最終出現', '']}>
          {data.stats.map((r) => (
            <tr key={r.skinId} className="border-t border-ink-700">
              <td className="px-4 py-2">
                <div className="flex items-center gap-3">
                  <SkinImage skin={r.skin} className="h-8 w-16" />
                  <span className="font-semibold">{r.skin?.nameJa ?? r.skinId}</span>
                </div>
              </td>
              <td className="px-4 py-2 text-mute">{r.skin?.weaponNameJa}</td>
              <td className="px-4 py-2">{r.count} 回</td>
              <td className="px-4 py-2 text-mute">{fmtDateTime(r.lastSeen, tz)}</td>
              <td className="px-4 py-2">{wishIds.has(r.skinId) && <Badge tone="red">ウィッシュリスト</Badge>}</td>
            </tr>
          ))}
        </Table>
      ) : tab === 'notifications' ? (
        <Table head={['日時', '種類', 'スキン', '結果', '試行', '詳細']}>
          {data.notifications.map((n) => (
            <tr key={n.id} className="border-t border-ink-700">
              <td className="px-4 py-2 text-mute">{fmtDateTime(n.sentAt ?? n.createdAt, tz)}</td>
              <td className="px-4 py-2">{KIND[n.kind] ?? n.kind}</td>
              <td className="px-4 py-2">{n.skinName ?? '—'}</td>
              <td className="px-4 py-2">{n.status === 'sent' ? <Badge tone="teal">送信済み</Badge> : <Badge tone="red">失敗</Badge>}</td>
              <td className="px-4 py-2 text-mute">{n.attempts}</td>
              <td className="max-w-xs truncate px-4 py-2 text-xs text-mute" title={n.error ?? ''}>
                {n.error ?? ''}
              </td>
            </tr>
          ))}
        </Table>
      ) : tab === 'runs' ? (
        <Table head={['開始', 'きっかけ', '取得方法', '結果', '一致', '通知', 'メッセージ']}>
          {data.runs.map((r) => (
            <tr key={r.id} className="border-t border-ink-700">
              <td className="px-4 py-2 text-mute">{fmtDateTime(r.startedAt, tz)}</td>
              <td className="px-4 py-2">{TRIGGER[r.trigger] ?? r.trigger}</td>
              <td className="px-4 py-2 text-mute">{r.provider}</td>
              <td className="px-4 py-2">{r.status === 'success' ? <Badge tone="teal">成功</Badge> : r.status === 'running' ? <Badge>実行中</Badge> : <Badge tone="red">失敗</Badge>}</td>
              <td className="px-4 py-2">{r.matchedCount}</td>
              <td className="px-4 py-2">{r.notifiedCount}</td>
              <td className="max-w-md truncate px-4 py-2 text-xs text-mute" title={r.message ?? ''}>
                {r.message}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Table head={['日時', '発生箇所', '内容']}>
          {data.errors.map((e) => (
            <tr key={e.id} className="border-t border-ink-700">
              <td className="whitespace-nowrap px-4 py-2 text-mute">{fmtDateTime(e.at, tz)}</td>
              <td className="px-4 py-2">{e.source}</td>
              <td className="px-4 py-2 text-xs">{e.message}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}

function Empty() {
  return <div className="border border-dashed border-ink-600 py-14 text-center text-mute">履歴はまだありません</div>
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  const rows = Array.isArray(children) ? children : [children]
  if (rows.length === 0) return <Empty />
  return (
    <div className="overflow-x-auto border border-ink-700 bg-ink-850">
      <table className="w-full text-sm">
        <thead className="bg-ink-800 text-left">
          <tr>
            {head.map((h) => (
              <th key={h} className="display px-4 py-2.5 text-[10px] font-bold text-mute">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
