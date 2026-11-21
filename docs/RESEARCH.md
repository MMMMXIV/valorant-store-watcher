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

## 参照
- https://developer.riotgames.com/docs/valorant
- https://valorant-api.com/
- https://github.com/techchrism/valorant-api-docs
- https://github.com/Turtdle/ValorantShopChecker
- https://github.com/NaoJ-practice/valorant-store-bot
