import type { Settings, SettingsPatch } from './settings'

export interface RepairFacts {
  /** Riot login cookies are stored (the user acknowledged the risk before logging in). */
  riotLoggedIn: boolean
  webhookConfigured: boolean
  botConfigured: boolean
  /** Discord user id kept outside the settings table (backup). */
  botUserId: string | null
}

/**
 * Restores settings that versions ≤ 1.3.1 could reset to defaults (a one-field change from the UI
 * overwrote every other setting). Only fixes states that are impossible by user action:
 *  - logged in to Riot but risk not acknowledged (login requires the acknowledgement, and revoking it logs out)
 *  - BOT configured but the notification target fell back to an unconfigured Webhook
 */
export function repairSettings(s: Settings, f: RepairFacts): SettingsPatch {
  const patch: SettingsPatch = {}
  if (f.riotLoggedIn && !s.riskAcknowledged) patch.riskAcknowledged = true
  if (!s.discordUserId && f.botUserId) patch.discordUserId = f.botUserId
  // the BOT token survived but the target fell back to an empty Webhook → show the BOT again
  // (if the user id was lost too, the BOT section asks for it)
  if (s.notifyChannel === 'webhook' && !f.webhookConfigured && f.botConfigured) patch.notifyChannel = 'bot'
  return patch
}
