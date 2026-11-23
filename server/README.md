# VALORANT Store Watcher — サーバー（管理型・Discordコマンド/将来のスマホAPI）

`docs/MOBILE_DESIGN.md` の「まとめて預かる（管理型）」サーバーの実装です。
`../src/core` のロジック（照合・ID正規化・Riot取得・バンドル/ナイトマーケット解析・通知文面）を再利用します。

> ⚠️ これは **他人のRiotログイン情報を預かって動く** サーバーです。本番運用は運営者（あなた）の責任で、
> あなた自身のサーバー上で行ってください。鍵（`VSW_SERVER_KEY`）は環境変数で与え、DBと別に管理します。
> この開発リポジトリでは **テスト用データのみ** で検証しています（本物の友達の認証情報は扱いません）。

## 現在できていること（Phase A・テスト済み）
- `SecretBox`：Cookieの AES-256-GCM 暗号化（鍵は env、所有者IDでAADバインド）
- `UserStore`：Discordユーザー → 複数Riotアカウント・ウィッシュリストの保管（インメモリ実装＋差し替え可能なIF）
- `CommandService`：`/store` `/check` `/wishlist` `/nightmarket` `/bundle` のコマンド処理
  （該当ユーザーのストアを取得し、本人にだけ見える ephemeral な埋め込みを返す）

## まだ未実装（次段階・あなたのトークン/サーバーが必要）
- Discord への接続（Gateway もしくは HTTP Interactions）とスラッシュコマンド登録
- `/connect`（Riot公式ログイン → Cookie 受け取り）の Web フロー＋同意記録
- 永続DB（SQLite/Postgres）実装、毎朝の巡回＋プッシュ通知
- デプロイ（無料枠）

## 鍵の作成
```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
これを `VSW_SERVER_KEY` に設定します（DBとは別の場所に保管）。
