/**
 * UNOFFICIAL Riot endpoints used by the VALORANT client / community tools.
 * Sources (checked 2026-11): Turtdle/ValorantShopChecker (2026-07), giorgi-o/SkinPeek,
 * techchrism/valorant-api-docs. Riot does not support these and may change them at any time.
 */
export const RIOT_AUTHORIZE_URL =
  'https://auth.riotgames.com/authorize' +
  '?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in' +
  '&client_id=play-valorant-web-prod' +
  '&response_type=token%20id_token' +
  '&nonce=1&scope=account%20openid'

export const RIOT_REDIRECT_PREFIX = 'https://playvalorant.com/opt_in'
export const RIOT_AUTH_HOST = 'auth.riotgames.com'
export const RIOT_USERINFO_URL = 'https://auth.riotgames.com/userinfo'
export const RIOT_ENTITLEMENTS_URL = 'https://entitlements.auth.riotgames.com/api/token/v1'
export const RIOT_PAS_URL = 'https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant'
export const storefrontUrl = (shard: string, puuid: string): string =>
  `https://pd.${shard}.a.pvp.net/store/v3/storefront/${encodeURIComponent(puuid)}`

/** base64 of the pretty-printed (tab, CRLF) client platform JSON, as sent by the game client. */
export const RIOT_CLIENT_PLATFORM = Buffer.from(
  JSON.stringify(
    { platformType: 'PC', platformOS: 'Windows', platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown' },
    null,
    '\t'
  ).replace(/\n/g, '\r\n')
).toString('base64')

export const RIOT_REGIONS = ['ap', 'kr', 'na', 'eu', 'latam', 'br'] as const
export type RiotRegion = (typeof RIOT_REGIONS)[number]

/** Store (pd) shard for a region: latam / br are served by the na shard. */
export function shardForRegion(region: string): string {
  return region === 'latam' || region === 'br' ? 'na' : region
}

export const REGION_LABEL: Record<string, string> = { ap: 'アジア太平洋 (AP)', kr: '韓国 (KR)', na: '北米 (NA)', eu: 'ヨーロッパ (EU)', latam: '中南米 (LATAM)', br: 'ブラジル (BR)' }
