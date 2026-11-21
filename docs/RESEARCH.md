# Phase 1 調査結果：ストア取得方法とポリシー（2026年11月時点）

> 本ドキュメントは開発時に確認した情報と、その時点で確認できなかった点を区別して記載しています。

## 1. Riot Games 公式APIの対応状況

- Riot Developer Portal の VALORANT API（`VAL-CONTENT-V1`, `VAL-MATCH-V1`, `VAL-RANKED-V1`, `VAL-STATUS-V1` など）は、
  **個人別のデイリーストア（Storefront）を提供していません**。
- 依頼仕様の記載どおり、**ストア監視は公式APIの「未承認用途」**として扱われています。
- ※ 開発環境のネットワーク制限で developer.riotgames.com を直接取得できなかったため、
  ポリシー本文の一字一句は本アプリ内のリンク（設定画面 → Riotアカウント連携）から各自で最新版を確認してください。

## 2. 開発ポリシー・利用規約

- 公式APIで提供されないデータを取得するために、ゲームクライアントが内部で使う非公開エンドポイントを利用することは、
  Riot が承認した利用方法ではありません。
- 非公式APIを使うBotの README でも、Riot が非公式APIの利用を禁止しているという注意書きが見られます
  （例: NaoJ-practice/valorant-store-bot）。

## 3. 非公式 VALORANT API の現状

| 情報源 | 内容 | 確認結果 |
|---|---|---|
| techchrism/valorant-api-docs | コミュニティが整理した**非公式**エンドポイント集 | 「These endpoints are **not** officially supported」と明記。現在は valapidocs.techchrism.me に移行済み |
| Storefront | `GET https://pd.{shard}.a.pvp.net/store/v2/storefront/{puuid}`（`Authorization: Bearer`, `X-Riot-Entitlements-JWT`） | GitHub上の資料はv2を記載。2026年時点で動作するか、v3へ変わったかは**未検証** |
| 応答の形 | `SkinsPanelLayout.SingleItemOffers`, `SingleItemStoreOffers[].Cost{通貨ID: 価格}`, `Rewards[].ItemID`, `SingleItemOffersRemainingDurationInSeconds` | 本アプリの「ストアJSON形式」取り込みはこの形に対応 |
| Valorant-API (valorant-api.com) | スキン名・画像などの**静的データ**。`/v1/weapons?language=ja-JP`, `/v1/contenttiers`, `/v1/version` | 実際に取得して確認。「unofficial API and is not endorsed by Riot Games」と明記 |
| VP通貨ID | `85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741`（/v1/currencies で確認） | 確認済み |

## 4. Riotアカウント認証の仕組み（非公式）

既存実装は次のどちらかです。

1. **ユーザー名＋パスワード**をツールに渡してログインする（NaoJ-practice/valorant-store-bot）
   → パスワードを第三者のプログラム／サーバーに預けることになり危険。
2. **ログイン後のCookie（ssid等）を保存して再認証**する（Turtdle/ValorantShopChecker）
   → Cookieはパスワード同等の秘密情報。Riotがローテーションすると再設定が必要。
3. **ローカルのRiotクライアント（lockfile）**から一時トークンを得る
   → Riotクライアント起動中しか使えず、無人運用には向かない。

## 5. 2段階認証（MFA）

- NaoJ-practice/valorant-store-bot は「2段階認証には対応していません」と明記し、
  2FAの無効化を案内しています（非推奨）。本アプリは**MFAを無効化させる設計を採りません**。

## 6. セッションの有効期限と再認証

- アクセストークンは発行から約1時間で失効（techchrism docs）。
- Cookie再認証で延長できますが、Cookie自体も失効・ローテーションされ、そのたびに人の操作が必要です
  （ValorantShopChecker は失効時にDiscordへ警告を出し、手動で再設定する運用）。

## 7. 無人で毎日取得できるか

- 技術的には非公式Cookie方式で「ある程度」可能ですが、**Riotが承認していない方法**であり、
  失効・仕様変更・CAPTCHA導入で予告なく止まります。

## 8. アカウントリスクと代替手段

- リスク：規約違反によるアカウント制限の可能性、認証情報の漏えい、予告なしの停止。
- 本アプリの方針（依頼仕様「許可された取得手段が利用できる場合のみ自動取得Providerを追加する」に従う）：
  - **Riotへのログイン・非公式API呼び出しは標準搭載しない**
  - 代替手段として以下を実装
    - `MockStoreProvider`：疑似ストア（全機能の動作検証用、自動チェック対応）
    - 手動取り込み：ゲーム内で見た4スキンを選んで入力／JSON貼り付け
    - JSONファイル監視：利用者が用意したJSONを定時に読む（自動チェック対応）
  - `StoreProvider` インターフェースで抽象化してあるため、将来Riotが公式に個人ストアAPIを提供した場合は
    Providerを1つ追加するだけで自動取得に対応できます。

## 9. 追記：Riotアカウント方式の実装（利用者の明示的な依頼により追加）

利用者から「自分だけで使う・リスクは承知」との明示的な依頼を受け、次の制約付きで実装しました。

| 手順 | エンドポイント（非公式） | 出典 |
|---|---|---|
| ログイン | Riot公式ページ `auth.riotgames.com/authorize?...client_id=play-valorant-web-prod...` → `playvalorant.com/opt_in#access_token=…&id_token=…` | ValorantShopChecker (2026-07), SkinPeek |
| 再認証 | 上記 authorize に `ssid` Cookie を付けてリダイレクトを追わずに取得（Location にトークン） | 同上 |
| エンタイトルメント | `POST entitlements.auth.riotgames.com/api/token/v1` | 同上 |
| アカウント | `GET auth.riotgames.com/userinfo`（sub=PUUID, acct.game_name/tag_line） | SkinPeek |
| 地域 | `PUT riot-geo.pas.si.riotgames.com/pas/v1/product/valorant` `{id_token}` → `affinities.live`（latam/br は na シャード） | SkinPeek |
| ストア | `POST pd.{shard}.a.pvp.net/store/v3/storefront/{puuid}` body `{}`、ヘッダー `Authorization`, `X-Riot-Entitlements-JWT`, `X-Riot-ClientVersion`（valorant-api.com /v1/version の riotClientVersion）, `X-Riot-ClientPlatform` | ValorantShopChecker, SkinPeek（v2 から v3 POST に変更済み） |

守っている制約：パスワードを受け取らない／保存しない、MFA・CAPTCHAは利用者がRiotのページで入力、ゲームメモリ読み取り・アンチチート回避なし、
Cookie は DPAPI で暗号化、Cookie 失効時は自動で再試行を止めて再ログインを促す、認証は最短15秒間隔・ストア取得は1日1回＋失敗時の再試行のみ。

**未検証事項**：開発環境から Riot のサーバーには接続できず、実アカウントでの動作確認はできていません。
擬似Riotサーバーで、ログイン画面からのトークン・Cookie取得、Cookie再認証、ストア取得、通知までの流れを Electron 実アプリ上で確認済みです。

## 参照
- https://developer.riotgames.com/docs/valorant
- https://valorant-api.com/
- https://github.com/techchrism/valorant-api-docs
- https://github.com/Turtdle/ValorantShopChecker
- https://github.com/NaoJ-practice/valorant-store-bot
