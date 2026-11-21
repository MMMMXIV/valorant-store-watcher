// UI smoke test: launches the built app with a throw-away profile and captures screenshots.
// Usage: xvfb-run node scripts/ui-smoke.cjs <outDir>
const { _electron } = require('playwright')
const path = require('path')
const fs = require('fs')
const os = require('os')

;(async () => {
  const out = process.argv[2] || 'screenshots'
  fs.mkdirSync(out, { recursive: true })
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vsw-ui-'))
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, VSW_USER_DATA: userData, NODE_ENV: 'production' }
  })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  win.on('console', (m) => m.type() === 'error' && console.log('renderer error:', m.text()))
  const shot = async (name) => {
    await win.waitForTimeout(1200)
    await win.screenshot({ path: path.join(out, `${name}.png`) })
    console.log('shot', name)
  }
  // wait for catalog
  for (let i = 0; i < 60; i++) {
    const n = await win.evaluate(async () => (await window.vsw.getState()).catalog.skinCount)
    if (n > 0) { console.log('catalog skins', n); break }
    await win.waitForTimeout(1000)
  }
  await win.getByRole('button', { name: /CATALOG/ }).click()
  await win.getByPlaceholder(/スキン名で検索/).fill('RGX ヴァンダル')
  await shot('02-catalog-search')
  await win.getByRole('button', { name: /ウィッシュリストに追加/ }).first().click()
  await win.getByPlaceholder(/スキン名で検索/).fill('')
  await win.getByRole('button', { name: 'ファントム', exact: true }).click()
  await win.getByRole('button', { name: /ウィッシュリストに追加/ }).nth(2).click()
  await shot('03-catalog-phantom')
  await win.evaluate(() => window.vsw.settings.update({ mockForceWishlistHit: true }))
  await win.getByRole('button', { name: /DASHBOARD/ }).click()
  await win.getByRole('button', { name: /今すぐチェック/ }).click()
  await shot('01-dashboard')
  await win.getByRole('button', { name: /WISHLIST/ }).click()
  await shot('04-wishlist')
  await win.getByRole('button', { name: /HISTORY/ }).click()
  await win.getByRole('button', { name: 'チェック履歴' }).click()
  await shot('05-history')
  await win.getByRole('button', { name: /SETTINGS/ }).click()
  await shot('06-settings')
  const st = await win.evaluate(() => window.vsw.getState())
  console.log(JSON.stringify({ provider: st.provider.id, matched: st.matchedSkinIds.length, lastRun: st.lastRun?.message, plan: st.plan, wish: st.wishlistCount }))
  await app.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
