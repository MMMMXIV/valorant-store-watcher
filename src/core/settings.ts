import { z } from 'zod'
import { isValidTimeZone } from './util/time'

export const ProviderIdSchema = z.enum(['mock', 'manual', 'manual-file', 'riot'])
export type ProviderId = z.infer<typeof ProviderIdSchema>

export const SettingsSchema = z.object({
  timezone: z.string().refine(isValidTimeZone, 'タイムゾーンが不正です').default('Asia/Tokyo'),
  /** Fallback daily check time (used when the source gives no refresh time). */
  checkTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:05'),
  /** Minutes to wait after the source-reported store refresh before checking. */
  checkDelayMinutes: z.number().int().min(0).max(180).default(5),
  autoCheckEnabled: z.boolean().default(true),
  providerId: ProviderIdSchema.default('mock'),
  retryMinutes: z.array(z.number().int().min(1).max(720)).min(1).max(10).default([5, 15, 30, 60]),
  notificationsEnabled: z.boolean().default(true),
  notifyWishlist: z.boolean().default(true),
  notifyDailyStore: z.boolean().default(false),
  notifyErrors: z.boolean().default(true),
  launchAtLogin: z.boolean().default(false),
  closeToTray: z.boolean().default(true),
  startHidden: z.boolean().default(true),
  /** Demo/test mode: Mock store always includes the highest-priority wishlist skin. */
  mockForceWishlistHit: z.boolean().default(false),
  mockSeed: z.string().max(64).default('vsw'),
  /** Absolute path of a JSON file read by the 'manual-file' provider. */
  manualFilePath: z.string().max(1024).nullable().default(null),
  catalogAutoUpdate: z.boolean().default(true),
  /** Must be true before the unofficial Riot provider can be used. */
  riskAcknowledged: z.boolean().default(false),
  /** Riot region for the store API. 'auto' = detect from Riot (PAS). */
  riotRegion: z.enum(['auto', 'ap', 'kr', 'na', 'eu', 'latam', 'br']).default('auto')
})
export type Settings = z.infer<typeof SettingsSchema>

export const SettingsPatchSchema = SettingsSchema.partial().strict()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})
