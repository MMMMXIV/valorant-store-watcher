import type { CatalogSkin } from '../lib/api'
import { fmtVp } from '../lib/format'
import { IconCheck, IconHeart, IconStar } from './Icons'
import { SkinImage, TierBadge } from './SkinImage'

export function StoreSkinCard({ skin, price, matched, slot }: { skin: CatalogSkin | null; price: number | null; matched: boolean; slot: number }) {
  return (
    <div
      className={`clip-corner group relative flex flex-col overflow-hidden border bg-gradient-to-b from-ink-800 to-ink-900 transition ${matched ? 'border-crimson shadow-[0_0_30px_-8px_rgba(255,70,85,0.6)]' : 'border-ink-700'}`}
    >
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
        <span className="display text-[10px] text-mute">SLOT {String(slot + 1).padStart(2, '0')}</span>
        {matched && (
          <span className="flex items-center gap-1 bg-crimson px-1.5 py-0.5 text-[10px] font-bold text-white">
            <IconStar width={10} height={10} /> WISHLIST
          </span>
        )}
      </div>
      <div className="relative flex h-40 items-center justify-center px-6 pt-8" style={{ background: skin?.tierColor ? `radial-gradient(circle at 50% 60%, ${skin.tierColor}22, transparent 70%)` : undefined }}>
        <SkinImage skin={skin} className="h-28 w-full drop-shadow-[0_10px_20px_rgba(0,0,0,0.6)] transition group-hover:scale-105" />
      </div>
      <div className="flex flex-1 flex-col gap-1 border-t border-ink-700 px-4 py-3">
        <div className="truncate font-bold" title={skin?.nameJa}>
          {skin?.nameJa ?? '不明なスキン（カタログ未登録）'}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-mute">
          <span className="whitespace-nowrap">{skin?.weaponNameJa ?? '—'}</span>
          <TierBadge skin={skin} />
        </div>
        <div className="display mt-1 text-lg font-black text-bone">{fmtVp(price)}</div>
      </div>
    </div>
  )
}

export function CatalogSkinCard({ skin, inWishlist, onToggle, busy }: { skin: CatalogSkin; inWishlist: boolean; onToggle: () => void; busy?: boolean }) {
  return (
    <div className={`group relative flex flex-col border bg-ink-850 transition hover:border-ink-500 ${inWishlist ? 'border-crimson/60' : 'border-ink-700'}`}>
      <div className="absolute inset-x-0 top-0 h-[2px]" style={{ background: skin.tierColor ?? 'transparent' }} />
      <div className="flex h-28 items-center justify-center px-4 pt-3">
        <SkinImage skin={skin} className="h-20 w-full" />
      </div>
      <div className="flex flex-1 flex-col px-3 pb-3 pt-2">
        <div className="truncate text-sm font-bold" title={skin.nameJa}>
          {skin.nameJa}
        </div>
        <div className="truncate text-[11px] text-mute" title={skin.nameEn}>
          {skin.nameEn}
        </div>
        <div className="mt-1.5 truncate">
          <TierBadge skin={skin} />
        </div>
        <button
          onClick={onToggle}
          disabled={busy}
          className={`clip-btn mt-3 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold transition ${inWishlist ? 'bg-crimson/15 text-crimson hover:bg-crimson/25' : 'bg-ink-700 text-bone hover:bg-crimson hover:text-white'}`}
        >
          {inWishlist ? (
            <>
              <IconCheck width={14} height={14} /> 登録済み
            </>
          ) : (
            <>
              <IconHeart width={14} height={14} /> ウィッシュリストに追加
            </>
          )}
        </button>
      </div>
    </div>
  )
}
