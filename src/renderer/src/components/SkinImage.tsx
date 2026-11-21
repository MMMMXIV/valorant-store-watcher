import { useState } from 'react'
import type { CatalogSkin } from '../lib/api'

export function SkinImage({ skin, className = '', render = false }: { skin: CatalogSkin | null; className?: string; render?: boolean }) {
  const [failed, setFailed] = useState(false)
  const src = render ? (skin?.renderUrl ?? skin?.iconUrl) : (skin?.iconUrl ?? skin?.renderUrl)
  if (!src || failed) {
    return <div className={`flex items-center justify-center text-xs text-ink-500 ${className}`}>NO IMAGE</div>
  }
  return <img src={src} alt={skin?.nameJa ?? ''} loading="lazy" draggable={false} onError={() => setFailed(true)} className={`object-contain ${className}`} />
}

export function TierBadge({ skin }: { skin: CatalogSkin | null }) {
  if (!skin?.tierName) return null
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold" style={{ color: skin.tierColor ?? undefined }}>
      <span className="inline-block h-2 w-2 rotate-45" style={{ background: skin.tierColor ?? '#888' }} />
      {skin.tierName}
    </span>
  )
}
