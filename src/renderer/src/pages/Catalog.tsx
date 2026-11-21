import { useDeferredValue, useMemo, useState } from 'react'
import { CatalogSkinCard } from '../components/SkinCard'
import { IconRefresh, IconSearch } from '../components/Icons'
import { Button, Notice, inputCls, useToast } from '../components/ui'
import { api, errText } from '../lib/api'
import { fmtDateTime } from '../lib/format'
import { searchSkinsUi } from '../lib/search'
import { useData } from '../lib/store'
import { PageHeader } from './Dashboard'

const PAGE = 96

export function Catalog() {
  const { skins, weapons, tiers, wishIds, state } = useData()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [weapon, setWeapon] = useState<string | null>(null)
  const [tier, setTier] = useState<string | null>(null)
  const [onlyWish, setOnlyWish] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const [pending, setPending] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const dq = useDeferredValue(q)

  const filtered = useMemo(() => {
    let r = searchSkinsUi(skins, dq, weapon)
    if (tier) r = r.filter((s) => s.tierId === tier)
    if (onlyWish) r = r.filter((s) => wishIds.has(s.id))
    return r
  }, [skins, dq, weapon, tier, onlyWish, wishIds])

  const toggle = async (id: string) => {
    setPending(id)
    try {
      if (wishIds.has(id)) {
        await api().wishlist.remove(id)
        toast('info', 'ウィッシュリストから削除しました')
      } else {
        await api().wishlist.add(id)
        toast('ok', 'ウィッシュリストに追加しました')
      }
    } catch (e) {
      toast('err', errText(e))
    } finally {
      setPending(null)
    }
  }

  const update = async () => {
    setUpdating(true)
    try {
      const st = await api().catalog.update(true)
      toast('ok', `カタログを更新しました（${st.skinCount}スキン）`)
    } catch (e) {
      toast('err', `カタログ更新に失敗しました: ${errText(e)}`)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="スキンカタログ"
        sub="SKIN CATALOG"
        right={
          <div className="flex items-center gap-3 text-xs text-mute">
            <span>
              {state?.catalog.skinCount ?? 0} スキン・更新 {fmtDateTime(state?.catalog.updatedAt)}
            </span>
            <Button variant="outline" onClick={update} busy={updating}>
              <IconRefresh width={16} height={16} /> データ更新
            </Button>
          </div>
        }
      />
      {skins.length === 0 && (
        <Notice tone="amber" title="カタログが未取得です">
          インターネットに接続した状態で「データ更新」を押してください。スキン情報は有志の非公式サービス Valorant-API から取得します。
        </Notice>
      )}
      <div className="sticky top-0 z-20 -mx-2 space-y-3 bg-ink-900/95 px-2 py-3 backdrop-blur">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <IconSearch className="absolute left-3 top-2.5 text-mute" />
            <input
              className={`${inputCls} pl-10`}
              placeholder="スキン名で検索（例: リーヴァー / Reaver / プライム ヴァンダル）"
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setLimit(PAGE)
              }}
            />
          </div>
          <select className={`${inputCls} max-w-44`} value={tier ?? ''} onChange={(e) => setTier(e.target.value || null)}>
            <option value="">すべてのレアリティ</option>
            {tiers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nameJa}
              </option>
            ))}
          </select>
          <button onClick={() => setOnlyWish(!onlyWish)} className={`px-3 text-xs font-semibold ring-1 ring-inset ${onlyWish ? 'bg-crimson/15 text-crimson ring-crimson/50' : 'text-mute ring-ink-600 hover:text-bone'}`}>
            登録済みのみ
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip active={!weapon} onClick={() => setWeapon(null)}>
            すべて
          </Chip>
          {weapons.map((w) => (
            <Chip key={w.id} active={weapon === w.id} onClick={() => { setWeapon(w.id); setLimit(PAGE) }}>
              {w.nameJa}
            </Chip>
          ))}
        </div>
      </div>
      <div className="text-xs text-mute">{filtered.length} 件</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
        {filtered.slice(0, limit).map((s) => (
          <CatalogSkinCard key={s.id} skin={s} inWishlist={wishIds.has(s.id)} busy={pending === s.id} onToggle={() => void toggle(s.id)} />
        ))}
      </div>
      {filtered.length > limit && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" onClick={() => setLimit(limit + PAGE)}>
            さらに表示（残り {filtered.length - limit} 件）
          </Button>
        </div>
      )}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`px-3 py-1 text-xs font-semibold transition ${active ? 'bg-crimson text-white' : 'bg-ink-800 text-mute hover:bg-ink-700 hover:text-bone'}`}>
      {children}
    </button>
  )
}
