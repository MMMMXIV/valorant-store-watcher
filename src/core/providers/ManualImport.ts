import { z } from 'zod'
import type { StoreOfferInput, StoreSnapshot } from '../types'
import { VP_CURRENCY_ID } from '../types'
import { normalizeUuid } from '../util/ids'
import { utcDayBounds } from './period'

/** App-native import format. */
const VswFormat = z.object({
  format: z.literal('vsw-store-v1'),
  accountId: z.string().min(1).max(128).optional(),
  accountName: z.string().max(128).optional(),
  /** Store date (YYYY-MM-DD, the UTC day / JST 9:00 rotation it belongs to). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().datetime({ offset: true }).optional(),
  offers: z
    .array(
      z
        .object({ id: z.string().max(64).optional(), name: z.string().max(128).optional(), price: z.number().int().min(0).max(100000).nullish() })
        .refine((o) => o.id || o.name, 'id または name が必要です')
    )
    .min(1)
    .max(8)
})

/**
 * Storefront-shaped JSON as documented by the community (techchrism/valorant-api-docs, "GET Store_GetStorefrontV2").
 * Only the fields we need are validated; unknown fields are ignored.
 */
const StorefrontFormat = z.object({
  SkinsPanelLayout: z.object({
    SingleItemOffers: z.array(z.string()).optional(),
    SingleItemStoreOffers: z
      .array(
        z.object({
          OfferID: z.string(),
          Cost: z.record(z.string(), z.number()).optional(),
          Rewards: z.array(z.object({ ItemID: z.string() }).passthrough()).optional()
        }).passthrough()
      )
      .optional(),
    SingleItemOffersRemainingDurationInSeconds: z.number().optional()
  }).passthrough()
}).passthrough()

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportFormatError'
  }
}

/** Parses pasted / file JSON into a StoreSnapshot. Supports `vsw-store-v1` and storefront JSON. */
export function parseStoreImport(text: string, now: Date, source = 'manual'): StoreSnapshot {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ImportFormatError('JSONとして読み込めません。形式を確認してください。')
  }
  const vsw = VswFormat.safeParse(json)
  if (vsw.success) {
    const d = vsw.data
    let periodEnd = d.periodEnd ? new Date(d.periodEnd).toISOString() : null
    let periodStart: string | null = null
    if (!periodEnd) {
      const base = d.date ? new Date(`${d.date}T00:00:00Z`) : now
      const b = utcDayBounds(base)
      periodStart = b.start.toISOString()
      periodEnd = b.end.toISOString()
    }
    return {
      accountId: d.accountId ?? 'manual',
      accountName: d.accountName ?? '手動入力',
      fetchedAt: now.toISOString(),
      periodStart,
      periodEnd,
      source,
      offers: d.offers.map<StoreOfferInput>((o) => ({
        itemId: o.id,
        name: o.name,
        price: o.price ?? null,
        currencyId: o.price != null ? VP_CURRENCY_ID : null
      }))
    }
  }
  const sf = StorefrontFormat.safeParse(json)
  if (sf.success) return snapshotFromStorefront(sf.data, now, { accountId: 'manual', accountName: '手動入力', source })
  throw new ImportFormatError('対応していない形式です（vsw-store-v1 形式 または ストアJSON形式に対応）')
}

/** Converts a storefront response (v2/v3 `SkinsPanelLayout`) into a snapshot. */
export function snapshotFromStorefront(
  data: unknown,
  now: Date,
  meta: { accountId: string; accountName: string | null; source: string }
): StoreSnapshot {
  const sf = StorefrontFormat.safeParse(data)
  if (!sf.success) throw new ImportFormatError('ストア応答に SkinsPanelLayout が含まれていません')
  {
    const p = sf.data.SkinsPanelLayout
    const offers: StoreOfferInput[] = []
    if (p.SingleItemStoreOffers?.length) {
      for (const o of p.SingleItemStoreOffers) {
        const item = o.Rewards?.[0]?.ItemID ?? o.OfferID
        const price = o.Cost?.[VP_CURRENCY_ID] ?? null
        offers.push({ itemId: item, price, currencyId: price != null ? VP_CURRENCY_ID : null })
      }
    } else {
      for (const id of p.SingleItemOffers ?? []) offers.push({ itemId: id, price: null })
    }
    if (!offers.length) throw new ImportFormatError('ストアのスキン情報が含まれていません')
    const rem = p.SingleItemOffersRemainingDurationInSeconds
    const periodEnd = typeof rem === 'number' && rem > 0 ? new Date(now.getTime() + rem * 1000).toISOString() : utcDayBounds(now).end.toISOString()
    return { accountId: meta.accountId, accountName: meta.accountName, fetchedAt: now.toISOString(), periodStart: null, periodEnd, source: meta.source, offers }
  }
}

/** Builds a vsw-store-v1 snapshot from skins picked in the UI. */
export function snapshotFromPicked(picks: Array<{ skinId: string; price: number | null }>, now: Date, date?: string): StoreSnapshot {
  const ids = picks.map((p) => normalizeUuid(p.skinId)).filter(Boolean)
  if (!ids.length || ids.length !== picks.length) throw new ImportFormatError('スキンIDが不正です')
  return parseStoreImport(
    JSON.stringify({ format: 'vsw-store-v1', date, offers: picks.map((p) => ({ id: p.skinId, price: p.price ?? undefined })) }),
    now
  )
}
