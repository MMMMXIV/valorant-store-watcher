import { z } from 'zod'
import { isValidTimeZone } from './util/time'

/** Store sources. Legacy values ('manual', 'manual-file') from v1.0 are migrated to 'riot'. */
export const ProviderIdSchema = z.preprocess((v) => (v === 'manual' || v === 'manual-file' ? 'riot' : v), z.enum(['riot', 'mock']))
export type ProviderId = z.infer<typeof ProviderIdSchema>

export const SettingsSchema = z.object({
  timezone: z.string().refine(isValidTimeZone, 'タイムゾーンが不正です').default('Asia/Tokyo'),
  /** Fallback daily check time (used when the source gives no refresh time). */
  checkTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:05'),
  /** Minutes to wait after the source-reported store refresh before checking. */
  checkDelayMinutes: z.number().int().min(0).max(180).default(5),
  autoCheckEnabled: z.boolean().default(true),
  providerId: ProviderIdSchema.default('riot'),
  retryMinutes: z.array(z.number().int().min(1).max(720)).min(1).max(10).default([5, 15, 30, 60]),
  notificationsEnabled: z.boolean().default(true),
  /** Where notifications go: a channel via Webhook, or the user's DMs via a BOT. */
  notifyChannel: z.enum(['webhook', 'bot']).default('webhook'),
  /** Windows desktop (toast) notifications, independent from Discord. */
  desktopNotifyWishlist: z.boolean().default(true),
  desktopNotifyStore: z.boolean().default(false),
  /** Discord user ID that receives BOT DMs (not secret). */
  discordUserId: z.string().regex(/^\d{15,21}$/).nullable().default(null),
  notifyWishlist: z.boolean().default(true),
  notifyDailyStore: z.boolean().default(false),
  notifyErrors: z.boolean().default(true),
  launchAtLogin: z.boolean().default(false),
  closeToTray: z.boolean().default(true),
  startHidden: z.boolean().default(true),
  /** Demo/test mode: Mock store always includes the highest-priority wishlist skin. */
  mockForceWishlistHit: z.boolean().default(false),
  mockSeed: z.string().max(64).default('vsw'),
  catalogAutoUpdate: z.boolean().default(true),
  /** Must be true before the unofficial Riot provider can be used. */
  riskAcknowledged: z.boolean().default(false),
  /** Riot region for the store API. 'auto' = detect from Riot (PAS). */
  riotRegion: z.enum(['auto', 'ap', 'kr', 'na', 'eu', 'latam', 'br']).default('auto')
})
export type Settings = z.infer<typeof SettingsSchema>

/**
 * Patch schema WITHOUT defaults. (With zod v4, `SettingsSchema.partial()` still fills in defaults
 * for missing keys, so a one-field patch from the UI used to reset every other setting.)
 */
export const SettingsPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(SettingsSchema.shape).map(([k, v]) => [k, (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : (v as z.ZodType)).optional()])
    ) as { [K in keyof typeof SettingsSchema.shape]: z.ZodOptional<z.ZodType<z.infer<typeof SettingsSchema>[K]>> }
  )
  .strict()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})
