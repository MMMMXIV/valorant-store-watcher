# Oracle Cloud Always Free へのデプロイ手順

このサーバー（Discordコマンドで自分のストアを確認）を、**ずっと無料**の Oracle Cloud Always Free のVMで動かす手順です。
追加の有料サービスは不要です。10人規模なら無料枠で十分動きます。

> ⚠️ これは **他人のRiotログイン情報を預かって動く** サーバーです。運用は運営者（あなた）の責任で行ってください。
> `VSW_SERVER_KEY`（復号鍵）は **DBと別の場所**（下記の環境変数ファイル）に置き、Gitには絶対に入れないでください。

---

## 用意するもの
- Oracle Cloud の無料アカウント（登録時にクレカ確認あり。Always Free の範囲なら課金されません）
- Discord の BOT（Developer Portal で作成。Windows版で作ったものを流用可）
  - **Bot Token** と **Application ID**
- 無料のドメイン（`/connect` ページを HTTPS で安全に出すため）。例: [DuckDNS](https://www.duckdns.org/)（無料）

---

## 1. VMを作る（Always Free）
1. Oracle Cloud → **Compute → Instances → Create instance**
2. Shape は **Always Free 対象**（例: `VM.Standard.A1.Flex`（ARM, 常時無料枠）または `VM.Standard.E2.1.Micro`）を選ぶ
3. Image は **Ubuntu 22.04** など
4. SSHキーを登録して作成
5. **パブリックIP** が付くので控える

## 2. 通信を許可する（ファイアウォール）
HTTPS（443）を開ける。2か所の設定が要る。
- Oracle側: VMのサブネットの **Security List** で Ingress に `0.0.0.0/0` の TCP 443 を追加
- VM内:
  ```bash
  sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save   # 無ければ: sudo apt install -y iptables-persistent
  ```

## 3. ドメインをIPに向ける
DuckDNS等で、サブドメイン（例 `yourname.duckdns.org`）を VM のパブリックIPに設定する。

## 4. Node とアプリを入れる
```bash
sudo apt update && sudo apt install -y git
# Node 20+（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
# 取得とビルド
git clone https://github.com/MMMMXIV/valorant-store-watcher.git
cd valorant-store-watcher
npm ci
npm run server:build
```

## 5. HTTPS を自動で付ける（Caddy）
`/connect` では ssid を入力するので、必ず HTTPS にする。Caddy は無料でLet's Encrypt証明書を自動取得・更新する。
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```
`/etc/caddy/Caddyfile` を次の内容にする（ドメインを自分のものに）:
```
yourname.duckdns.org {
    reverse_proxy 127.0.0.1:8080
}
```
```bash
sudo systemctl restart caddy
```

## 6. 鍵と環境変数（DBと別に保管）
鍵を生成:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
`/etc/vsw.env` を作る（**600 権限**、Gitに入れない）:
```bash
sudo tee /etc/vsw.env >/dev/null <<'ENV'
VSW_SERVER_KEY=（上で生成した鍵）
DISCORD_BOT_TOKEN=（BotのToken）
DISCORD_APP_ID=（Application ID）
PUBLIC_BASE_URL=https://yourname.duckdns.org
DATA_DIR=/home/ubuntu/valorant-store-watcher/server/data
PORT=8080
ENV
sudo chmod 600 /etc/vsw.env
```

## 7. 常駐サービス（systemd）
`/etc/systemd/system/vsw.service`:
```ini
[Unit]
Description=VALORANT Store Watcher server
After=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/valorant-store-watcher
EnvironmentFile=/etc/vsw.env
ExecStart=/usr/bin/node server/dist/server.cjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vsw
sudo systemctl status vsw         # 稼働確認
journalctl -u vsw -f              # ログ確認
```
起動すると、スラッシュコマンド（`/store` など）が自動登録され、ゲートウェイに接続する。

## 8. 使い方（友達向け）
1. Discordで **`/connect`** を打つ → あなた専用の連携リンクがDMで届く
2. リンクを開く → 同意 → Riot公式でログイン → `ssid` をコピーして貼り付け → 連携完了
3. **`/store`** で今日の自分のストアが（本人にだけ見える形で）表示される
4. `/check` `/wishlist` `/nightmarket` `/bundle` も使える

## 更新する
```bash
cd valorant-store-watcher && git pull && npm ci && npm run server:build && sudo systemctl restart vsw
```

## 退会・削除
- 友達: Discordの `/disconnect`（実装予定）か、あなたが手動で該当ユーザーを削除
- 運営終了時: `server/data/` を削除し、`/etc/vsw.env`（鍵）を削除すれば、残った暗号文は復号不能になる

---

## まだ未実装（このサーバーの現状）
- `/disconnect`（退会）コマンド … 近く追加予定
- ウィッシュリストのDiscord上での編集（現状は空。アプリ連携 or コマンド追加が必要）
- 毎朝の自動巡回＋プッシュ/通知（オンデマンドの `/store` は動作）

## セキュリティ注意
- `VSW_SERVER_KEY` と `/etc/vsw.env` は絶対に共有・コミットしない
- VMのOSを定期更新（`sudo apt upgrade`）
- SSHは鍵認証のみ、不要ポートは閉じる
- ログに秘密情報は出さない（アプリ側で自動マスク済み）
