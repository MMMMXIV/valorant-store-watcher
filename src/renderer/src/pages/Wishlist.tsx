import { useMemo, useState } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Page } from '../App'
import { IconDown, IconGrip, IconSearch, IconTrash, IconUp } from '../components/Icons'
import { SkinImage, TierBadge } from '../components/SkinImage'
import { Badge, Button, inputCls, useToast } from '../components/ui'
import { api, errText, type Priority, type WishlistItem } from '../lib/api'
import { fmtDate } from '../lib/format'
import { normalizeName } from '../../../core/util/ids'
import { useData } from '../lib/store'
import { PageHeader } from './Dashboard'

export function Wishlist({ go }: { go: (p: Page) => void }) {
  const { wishlist, weapons, state, refresh } = useData()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [weapon, setWeapon] = useState<string>('')
  const [order, setOrder] = useState<string[] | null>(null)
  const matched = new Set(state?.matchedSkinIds ?? [])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  const items = useMemo(() => {
    const byId = new Map(wishlist.map((w) => [w.skinId, w]))
    const base = order ? order.map((id) => byId.get(id)).filter(Boolean) as WishlistItem[] : wishlist
    return base
  }, [wishlist, order])
  const filtering = q.trim() !== '' || weapon !== ''
  const visible = useMemo(() => {
    const terms = normalizeName(q).split(' ').filter(Boolean)
    return items.filter((w) => {
      if (weapon && w.skin?.weaponId !== weapon) return false
      if (!terms.length) return true
      const hay = normalizeName(`${w.skin?.nameJa} ${w.skin?.nameEn} ${w.skin?.weaponNameJa} ${w.skin?.weaponNameEn}`)
      return terms.every((t) => hay.includes(t))
    })
  }, [items, q, weapon])

  const persist = async (ids: string[]) => {
    setOrder(ids)
    try {
      await api().wishlist.reorder(ids)
      await refresh()
    } catch (e) {
      toast('err', errText(e))
    } finally {
      setOrder(null)
    }
  }
  const move = (id: string, delta: number) => {
    const ids = items.map((w) => w.skinId)
    const i = ids.indexOf(id)
    const j = i + delta
    if (j < 0 || j >= ids.length) return
    void persist(arrayMove(ids, i, j))
  }
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const ids = items.map((w) => w.skinId)
    void persist(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))))
  }
  const setPriority = async (id: string, p: Priority) => {
    try {
      await api().wishlist.setPriority(id, p)
    } catch (e) {
      toast('err', errText(e))
    }
  }
  const remove = async (id: string) => {
    try {
      await api().wishlist.remove(id)
      toast('info', '登録を解除しました')
    } catch (e) {
      toast('err', errText(e))
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="ウィッシュリスト" sub="WISHLIST" right={<Button variant="outline" onClick={() => go('catalog')}>カタログから追加</Button>} />
      <div className="flex gap-3">
        <div className="relative flex-1">
          <IconSearch className="absolute left-3 top-2.5 text-mute" />
          <input className={`${inputCls} pl-10`} placeholder="登録スキンを検索" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className={`${inputCls} max-w-48`} value={weapon} onChange={(e) => setWeapon(e.target.value)}>
          <option value="">すべての武器</option>
          {weapons.map((w) => (
            <option key={w.id} value={w.id}>
              {w.nameJa}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-mute">
        上にあるスキンほど優先して通知に表示されます。ドラッグ（または ▲▼ ボタン）で並べ替え、優先度「高」は通知で強調されます。
        {filtering && ' ※ 絞り込み中はドラッグでの並べ替えはできません。'}
      </p>
      {wishlist.length === 0 ? (
        <div className="border border-dashed border-ink-600 py-16 text-center text-mute">
          まだ登録がありません。<button className="text-crimson underline" onClick={() => go('catalog')}>スキンカタログ</button>から追加してください。
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={visible.map((w) => w.skinId)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {visible.map((w) => (
                <Row
                  key={w.skinId}
                  item={w}
                  index={items.indexOf(w)}
                  total={items.length}
                  dragDisabled={filtering}
                  matched={matched.has(w.skinId)}
                  onMove={(d) => move(w.skinId, d)}
                  onPriority={(p) => void setPriority(w.skinId, p)}
                  onRemove={() => void remove(w.skinId)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}

function Row(props: {
  item: WishlistItem
  index: number
  total: number
  dragDisabled: boolean
  matched: boolean
  onMove: (d: number) => void
  onPriority: (p: Priority) => void
  onRemove: () => void
}) {
  const { item, index, total, dragDisabled, matched } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.skinId, disabled: dragDisabled })
  const s = item.skin
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-4 border bg-ink-850 px-4 py-3 ${isDragging ? 'z-10 border-crimson shadow-2xl' : matched ? 'border-crimson/70' : 'border-ink-700'}`}
    >
      <button {...attributes} {...listeners} disabled={dragDisabled} className="cursor-grab text-mute hover:text-bone disabled:cursor-not-allowed disabled:opacity-30" aria-label="ドラッグして並べ替え">
        <IconGrip />
      </button>
      <span className="display w-8 text-center text-sm font-black text-mute">{String(index + 1).padStart(2, '0')}</span>
      <SkinImage skin={s} className="h-12 w-28" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-bold">{s?.nameJa ?? item.skinId}</span>
          {matched && <Badge tone="red">本日ストアに登場中</Badge>}
          {s?.removed && <Badge tone="amber">カタログから削除済み</Badge>}
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-xs text-mute">
          <span>{s?.weaponNameJa}</span>
          <TierBadge skin={s} />
          <span>登録 {fmtDate(item.addedAt)}</span>
        </div>
      </div>
      <div className="flex items-center gap-1" role="radiogroup" aria-label="優先度">
        {(['high', 'normal', 'low'] as const).map((p) => (
          <button
            key={p}
            onClick={() => props.onPriority(p)}
            className={`w-9 py-1 text-xs font-bold ${item.priority === p ? (p === 'high' ? 'bg-crimson text-white' : 'bg-ink-500 text-bone') : 'bg-ink-800 text-mute hover:text-bone'}`}
          >
            {p === 'high' ? '高' : p === 'normal' ? '中' : '低'}
          </button>
        ))}
      </div>
      <div className="flex flex-col">
        <button className="text-mute hover:text-bone disabled:opacity-20" disabled={index === 0} onClick={() => props.onMove(-1)} aria-label="上へ">
          <IconUp width={16} height={16} />
        </button>
        <button className="text-mute hover:text-bone disabled:opacity-20" disabled={index === total - 1} onClick={() => props.onMove(1)} aria-label="下へ">
          <IconDown width={16} height={16} />
        </button>
      </div>
      <button className="p-2 text-mute hover:text-crimson" onClick={props.onRemove} aria-label="登録解除" title="登録解除">
        <IconTrash />
      </button>
    </div>
  )
}
