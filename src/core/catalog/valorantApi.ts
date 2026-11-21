/**
 * Minimal typed client for https://valorant-api.com (community, unofficial, read-only static data).
 * Only documented public endpoints are used: /v1/version, /v1/weapons, /v1/contenttiers.
 */
import { fetchJson, type FetchLike } from '../util/http'

export const VALORANT_API_BASE = 'https://valorant-api.com'

export interface ApiEnvelope<T> {
  status: number
  data: T
}

export interface ApiSkinLevel {
  uuid: string
  displayName: string
  displayIcon: string | null
}
export interface ApiSkinChroma {
  uuid: string
  displayName: string
  displayIcon: string | null
  fullRender: string | null
}
export interface ApiSkin {
  uuid: string
  displayName: string
  contentTierUuid: string | null
  displayIcon: string | null
  assetPath: string
  levels: ApiSkinLevel[]
  chromas: ApiSkinChroma[]
}
export interface ApiWeapon {
  uuid: string
  displayName: string
  category: string
  defaultSkinUuid: string
  skins: ApiSkin[]
}
export interface ApiContentTier {
  uuid: string
  displayName: string
  devName: string
  rank: number
  highlightColor: string
}
export interface ApiVersion {
  manifestId: string
  version: string
  riotClientVersion: string
  buildDate: string
}

export class ValorantApiClient {
  constructor(
    private fetchImpl: FetchLike,
    private base = VALORANT_API_BASE
  ) {}

  private async get<T>(path: string): Promise<T> {
    const body = await fetchJson<ApiEnvelope<T>>(this.fetchImpl, `${this.base}${path}`, 30000)
    if (!body || body.status !== 200 || body.data === undefined) throw new Error(`Valorant-API の応答が不正です (${path})`)
    return body.data
  }

  version(): Promise<ApiVersion> {
    return this.get('/v1/version')
  }
  weapons(language: 'ja-JP' | 'en-US'): Promise<ApiWeapon[]> {
    return this.get(`/v1/weapons?language=${language}`)
  }
  contentTiers(language: 'ja-JP' | 'en-US'): Promise<ApiContentTier[]> {
    return this.get(`/v1/contenttiers?language=${language}`)
  }
}
