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
  'riot:login': z.undefined(),
  'riot:loginWithSsid': z.object({ ssid: z.string().min(10).max(4096) }),
  'riot:logout': z.undefined(),
  'update:check': z.undefined(),
  'update:download': z.undefined(),
  'update:install': z.undefined()
} as const

export type IpcChannel = keyof typeof IpcSchemas
export type IpcArg<C extends IpcChannel> = z.infer<(typeof IpcSchemas)[C]>
