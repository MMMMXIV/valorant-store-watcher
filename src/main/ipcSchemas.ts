import { z } from 'zod'
import { SettingsPatchSchema } from '../core/settings'

const Uuid = z.string().trim().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
export const PrioritySchema = z.enum(['high', 'normal', 'low'])

/** Every IPC channel and the schema of its (single) argument. */
export const IpcSchemas = {
  'app:getState': z.undefined(),
  'catalog:list': z.undefined(),
  'catalog:update': z.object({ force: z.boolean() }),
  'wishlist:list': z.undefined(),
  'wishlist:add': z.object({ skinId: Uuid, priority: PrioritySchema.optional() }),
  'wishlist:remove': z.object({ skinId: Uuid }),
  'wishlist:setPriority': z.object({ skinId: Uuid, priority: PrioritySchema }),
  'wishlist:reorder': z.object({ ids: z.array(Uuid).max(2000) }),
  'store:checkNow': z.undefined(),
  'history:get': z.undefined(),
  'settings:update': SettingsPatchSchema,
  'webhook:set': z.object({ url: z.string().trim().max(300) }),
  'webhook:clear': z.undefined(),
  'webhook:test': z.object({ url: z.string().trim().max(300).optional() }),
  'monitor:setPaused': z.object({ paused: z.boolean() }),
  'diagnostics:get': z.undefined(),
  'app:openExternal': z.object({ url: z.string().url().max(500) }),
  'app:openLogs': z.undefined(),
  'app:wipeAll': z.object({ confirm: z.string().max(20) }),
  'tier:load': z.undefined(),
  'tier:save': z.object({ data: z.unknown() }),
  'tier:export': z.object({
    action: z.enum(['save', 'copy', 'sharex']),
    spec: z.object({
      title: z.string().max(80),
      dateLabel: z.string().max(40),
      tiers: z.array(z.object({
        label: z.string().max(6),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        skins: z.array(z.object({ name: z.string().max(80), weapon: z.string().max(40), icon: z.string().url().max(400).nullable() })).max(200)
      })).max(10)
    })
  }),
  'riot:login': z.object({ key: z.string().max(40).optional(), label: z.string().max(20).optional() }),
  'riot:loginWithSsid': z.object({ key: z.string().max(40).optional(), label: z.string().max(20).optional(), ssid: z.string().min(10).max(4096) }),
  'riot:rename': z.object({ key: z.string().max(40), label: z.string().min(1).max(20) }),
  'riot:setRegion': z.object({ key: z.string().max(40), region: z.enum(['auto', 'ap', 'kr', 'na', 'eu', 'latam', 'br']) }),
  'riot:removeAccount': z.object({ key: z.string().max(40) }),
  'riot:logout': z.undefined(),
  'bot:set': z.object({ token: z.string().trim().max(200).optional(), userId: z.string().trim().max(30) }),
  'bot:clear': z.undefined(),
  'bot:test': z.undefined(),
  'update:check': z.undefined(),
  'update:download': z.undefined(),
  'update:install': z.undefined()
} as const

export type IpcChannel = keyof typeof IpcSchemas
export type IpcArg<C extends IpcChannel> = z.infer<(typeof IpcSchemas)[C]>
