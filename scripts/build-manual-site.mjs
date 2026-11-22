// Builds a standalone static site from docs/manual (the page is authored as an HTML fragment
// for the claude.ai page host) → site/  (deployed to Cloudflare Pages).
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const src = path.join(root, 'docs', 'manual')
const out = path.join(root, 'site')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'img'), { recursive: true })

const fragment = fs.readFileSync(path.join(src, 'index.html'), 'utf8')
// everything before the first visible element (<title>, <meta>, <link>, <style>) belongs in <head>
const cut = fragment.indexOf('<header')
if (cut < 0) throw new Error('docs/manual/index.html: <header> not found')
const headExtra = fragment.slice(0, cut).trim()
const body = fragment.slice(cut)
const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="VALORANT Store Watcher（非公式）のダウンロードと使い方。Riotアカウント連携、Discord Webhook／BOTでの通知設定を初心者向けに説明します。">
<meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="favicon.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
${headExtra}
</head>
<body>
${body}
</body>
</html>
`
fs.writeFileSync(path.join(out, 'index.html'), html)
for (const f of fs.readdirSync(path.join(src, 'img'))) fs.copyFileSync(path.join(src, 'img', f), path.join(out, 'img', f))
fs.copyFileSync(path.join(root, 'resources', 'tray.png'), path.join(out, 'favicon.png'))
// security headers for Cloudflare Pages
fs.writeFileSync(
  path.join(out, '_headers'),
  `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
/img/*
  Cache-Control: public, max-age=86400
`
)
console.log(`site/ built: ${fs.readdirSync(out).join(', ')}`)
