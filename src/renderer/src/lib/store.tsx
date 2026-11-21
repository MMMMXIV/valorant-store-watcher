import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type AppState, type CatalogSkin, type ContentTier, type Weapon, type WishlistItem } from './api'

interface Data {
  state: AppState | null
  skins: CatalogSkin[]
  weapons: Weapon[]
  tiers: ContentTier[]
  wishlist: WishlistItem[]
  wishIds: Set<string>
  refresh: () => Promise<void>
}

const Ctx = createContext<Data | null>(null)
export const useData = (): Data => useContext(Ctx)!

export function DataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null)
  const [cat, setCat] = useState<{ skins: CatalogSkin[]; weapons: Weapon[]; tiers: ContentTier[] }>({ skins: [], weapons: [], tiers: [] })
  const [wishlist, setWishlist] = useState<WishlistItem[]>([])
  const catalogStamp = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    const [s, w] = await Promise.all([api().getState(), api().wishlist.list()])
    setState(s)
    setWishlist(w)
    const stamp = `${s.catalog.skinCount}|${s.catalog.updatedAt}`
    if (stamp !== catalogStamp.current) {
      catalogStamp.current = stamp
      setCat(await api().catalog.list())
    }
  }, [])

  useEffect(() => {
    void refresh()
    const off = api().onStateChanged(() => void refresh())
    const t = setInterval(() => void refresh(), 30_000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refresh])

  const wishIds = useMemo(() => new Set(wishlist.map((w) => w.skinId)), [wishlist])
  return <Ctx.Provider value={{ state, ...cat, wishlist, wishIds, refresh }}>{children}</Ctx.Provider>
}
