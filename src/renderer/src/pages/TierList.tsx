import { useEffect, useMemo, useRef, useState } from 'react'
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { IconRefresh, IconSearch, IconX } from '../components/Icons'
import { SkinImage } from '../components/SkinImage'
import { Button, inputCls, useToast } from '../components/ui'
import { api, errText, type CatalogSkin } from '../lib/api'
import { searchSkinsUi } from '../lib/search'
import { useData } from '../lib/store'
import { PageHeader } from './Dashboard'

interface Tier {
  id: string
  label: string
  color: string
  skinIds: string[]
}

const DEFAULT_TIERS: Tier[] = [
  { id: 't-s', label: 'S', color: '#ff4655', skinIds: [] },
  { id: 't-a', label: 'A', color: '#ff8f3f', skinIds: [] },
  { id: 't-b', label: 'B', color: '#ffd23f', skinIds: [] },
  { id: 't-c', label: 'C', color: '#6bd36b', skinIds: [] }
]

export function TierList() {
  const { skins, weapons } = useData()
  const toast = useToast()
  const byId = useMemo(() => new Map(skins.map((s) => [s.id, s])), [skins])
  const [title, setTitle] = useState('私のスキンTier表')
  const [tiers, setTiers] = useState<Tier[]>(DEFAULT_TIERS)
  const [q, setQ] = useState('')
  const [weapon, setWeapon] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const loaded = useRef(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // load saved tier list once
  useEffect(() => {
    void api()
      .tier.load()
      .then((saved: any) => {
        if (saved && Array.isArray(saved.tiers)) {
          setTitle(typeof saved.title === 'string' ? saved.title : '私のスキンTier表')
          setTiers(
            saved.tiers.map((t: any, i: number) => ({
              id: t.id ?? `t-${i}`,
              label: String(t.label ?? '').slice(0, 4) || DEFAULT_TIERS[i]?.label || '?',
              color: /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : (DEFAULT_TIERS[i]?.color ?? '#888888'),
              skinIds: Array.isArray(t.skinIds) ? t.skinIds.filter((x: unknown) => typeof x === 'string') : []
            }))
          )
        }
      })
      .finally(() => (loaded.current = true))
  }, [])

  // autosave (debounced) after first load
  useEffect(() => {
    if (!loaded.current) return
    const h = setTimeout(() => void api().tier.save({ title, tiers }).catch(() => undefined), 400)
    return () => clearTimeout(h)
  }, [title, tiers])

  const placed = useMemo(() => new Set(tiers.flatMap((t) => t.skinIds)), [tiers])
  const results = useMemo(() => {
    const r = searchSkinsUi(skins, q, weapon)
    return r.slice(0, 60)
  }, [skins, q, weapon])

  const move = (skinId: string, toTierId: string | null) => {
    setTiers((prev) => {
      const next = prev.map((t) => ({ ...t, skinIds: t.skinIds.filter((id) => id !== skinId) }))
      if (toTierId) {
        const t = next.find((x) => x.id === toTierId)
        if (t && !t.skinIds.includes(skinId)) t.skinIds.push(skinId)
      }
      return next
    })
  }

  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null)
    const skinId = String(e.active.id).replace(/^skin:/, '')
    const over = e.over ? String(e.over.id) : null
    if (!over) return
    if (over === 'pool') move(skinId, null)
    else if (over.startsWith('t-')) move(skinId, over)
  }

  const exportImg = async (action: 'save' | 'copy' | 'sharex') => {
    const used = tiers.some((t) => t.skinIds.length)
    if (!used) {
      toast('err', 'スキンを1つ以上Tierに入れてください')
      return
    }
    setBusy(action)
    try {
      const spec = {
        title: title.trim() || 'スキンTier表',
        dateLabel: new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
        tiers: tiers.map((t) => ({
          label: t.label,
          color: t.color,
          skins: t.skinIds.map((id) => byId.get(id)).filter(Boolean).map((s) => ({ name: s!.nameJa, weapon: s!.weaponNameJa, icon: s!.iconUrl ?? s!.renderUrl }))
        }))
      }
      const r: any = await api().tier.export(action, spec)
      if (r?.canceled) return
      if (action === 'save') toast('ok', `画像を保存しました: ${r.path}`)
      else if (action === 'sharex') toast('ok', '画像をクリップボードにコピーし、Xの投稿画面を開きました。投稿欄に貼り付け（Ctrl+V）してください。')
      else toast('ok', '画像をクリップボードにコピーしました。Discordやチャットに貼り付け（Ctrl+V）できます。')
    } catch (e) {
      toast('err', errText(e))
    } finally {
      setBusy(null)
    }
  }

  const clearAll = () => {
    if (!placed.size) return
    setTiers((prev) => prev.map((t) => ({ ...t, skinIds: [] })))
    toast('info', 'すべて外しました')
  }

  const dragSkin = dragId ? byId.get(dragId.replace(/^skin:/, '')) : null

  return (
    <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setDragId(String(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
      <div className="space-y-5">
        <PageHeader
          title="Tier表メーカー"
          sub="TIER LIST"
          right={
            <div className="flex gap-2">
              <Button variant="ghost" onClick={clearAll}>
                すべて外す
              </Button>
              <Button variant="outline" busy={busy === 'copy'} onClick={() => void exportImg('copy')}>
                画像をコピー
              </Button>
              <Button variant="outline" busy={busy === 'save'} onClick={() => void exportImg('save')}>
                画像を保存
              </Button>
              <Button busy={busy === 'sharex'} onClick={() => void exportImg('sharex')}>
                <XLogo /> でシェア
              </Button>
            </div>
          }
        />

        <div className="flex items-center gap-3">
          <label className="text-xs text-mute">タイトル</label>
          <input className={`${inputCls} max-w-md`} value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="例: 俺の好きなヴァンダルスキン" />
        </div>

        {/* tiers */}
        <div className="border border-ink-700">
          {tiers.map((t) => (
            <TierRow key={t.id} tier={t} skins={t.skinIds.map((id) => byId.get(id)).filter(Boolean) as CatalogSkin[]} onRemove={(id) => move(id, null)} onColor={(c) => setTiers((p) => p.map((x) => (x.id === t.id ? { ...x, color: c } : x)))} onLabel={(l) => setTiers((p) => p.map((x) => (x.id === t.id ? { ...x, label: l } : x)))} />
          ))}
        </div>

        {/* catalog pool */}
        <PoolArea>
          <div className="mb-3 flex flex-wrap gap-3">
            <div className="relative min-w-60 flex-1">
              <IconSearch className="absolute left-3 top-2.5 text-mute" />
              <input className={`${inputCls} pl-10`} placeholder="スキンを検索してTierにドラッグ（日本語・英語）" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select className={`${inputCls} max-w-48`} value={weapon ?? ''} onChange={(e) => setWeapon(e.target.value || null)}>
              <option value="">すべての武器</option>
              {weapons.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.nameJa}
                </option>
              ))}
            </select>
          </div>
          <p className="mb-3 text-xs text-mute">カードをつかんで上のTierにドラッグすると追加できます。Tierのスキンをここに戻すと外せます。</p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
            {results.map((s) => (
              <DraggableSkin key={s.id} skin={s} from="pool" placed={placed.has(s.id)} />
            ))}
            {!results.length && <div className="col-span-full py-6 text-center text-sm text-mute">検索結果がありません</div>}
          </div>
        </PoolArea>
      </div>

      <DragOverlay dropAnimation={null}>{dragSkin ? <SkinChip skin={dragSkin} overlay /> : null}</DragOverlay>
    </DndContext>
  )
}

function TierRow({ tier, skins, onRemove, onColor, onLabel }: { tier: Tier; skins: CatalogSkin[]; onRemove: (id: string) => void; onColor: (c: string) => void; onLabel: (l: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: tier.id })
  return (
    <div className={`flex items-stretch border-b border-ink-700 last:border-b-0 ${isOver ? 'bg-crimson/5' : ''}`}>
      <div className="relative flex w-24 flex-none flex-col items-center justify-center gap-1 py-3" style={{ background: tier.color }}>
        <input value={tier.label} maxLength={4} onChange={(e) => onLabel(e.target.value)} className="w-16 bg-transparent text-center text-3xl font-black text-ink-950 outline-none" style={{ fontFamily: 'Bahnschrift, Segoe UI, sans-serif' }} aria-label="Tier名" />
        <input type="color" value={tier.color} onChange={(e) => onColor(e.target.value)} className="h-4 w-8 cursor-pointer border-0 bg-transparent p-0 opacity-70 hover:opacity-100" aria-label="Tierの色" title="色を変更" />
      </div>
      <div ref={setNodeRef} className="flex min-h-24 flex-1 flex-wrap content-start gap-2 bg-ink-900/60 p-2.5">
        {skins.map((s) => (
          <DraggableSkin key={s.id} skin={s} from={tier.id} onRemove={() => onRemove(s.id)} />
        ))}
        {!skins.length && <div className="flex items-center px-2 text-sm text-ink-600">ここにドラッグ</div>}
      </div>
    </div>
  )
}

function PoolArea({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'pool' })
  return (
    <section ref={setNodeRef} className={`border p-4 ${isOver ? 'border-crimson bg-crimson/5' : 'border-ink-700 bg-ink-850'}`}>
      {children}
    </section>
  )
}

function DraggableSkin({ skin, from, placed, onRemove }: { skin: CatalogSkin; from: string; placed?: boolean; onRemove?: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `skin:${skin.id}`, data: { from } })
  return (
    <div ref={setNodeRef} className={`relative ${isDragging ? 'opacity-30' : ''}`}>
      <div {...attributes} {...listeners} className="cursor-grab touch-none active:cursor-grabbing">
        <SkinChip skin={skin} dim={placed} />
      </div>
      {onRemove && (
        <button onClick={onRemove} className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center bg-ink-700 text-mute hover:bg-crimson hover:text-white" aria-label="外す" title="外す">
          <IconX width={12} height={12} />
        </button>
      )}
    </div>
  )
}

function SkinChip({ skin, dim, overlay }: { skin: CatalogSkin; dim?: boolean; overlay?: boolean }) {
  return (
    <div className={`w-[150px] border bg-gradient-to-b from-ink-800 to-ink-900 ${overlay ? 'border-crimson shadow-2xl' : 'border-ink-700'} ${dim ? 'opacity-40' : ''}`}>
      <div className="flex h-14 items-center justify-center px-2 pt-1.5">
        <SkinImage skin={skin} className="h-12 w-full" />
      </div>
      <div className="min-w-0 px-2 pb-1.5">
        <div className="truncate text-[11px] font-bold" title={skin.nameJa}>
          {skin.nameJa}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[10px] text-mute" title={skin.weaponNameJa}>{skin.weaponNameJa}</span>
          <span className="ml-auto inline-block h-2 w-2 flex-none rotate-45" style={{ background: skin.tierColor ?? '#555' }} title={skin.tierName ?? ''} />
        </div>
      </div>
    </div>
  )
}

function XLogo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.9 2H22l-7.3 8.3L23 22h-6.6l-5.2-6.8L5.2 22H2l7.8-8.9L1.4 2h6.8l4.7 6.2L18.9 2Zm-1.2 18h1.8L7.1 3.9H5.2L17.7 20Z" />
    </svg>
  )
}
