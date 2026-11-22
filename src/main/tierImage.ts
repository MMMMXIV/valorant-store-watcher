import { BrowserWindow, net } from 'electron'

export interface TierSpecSkin {
  name: string
  weapon: string
  icon: string | null
}
export interface TierSpecRow {
  label: string
  color: string
  skins: TierSpecSkin[]
}
export interface TierSpec {
  title: string
  dateLabel: string
  tiers: TierSpecRow[]
}

const SCALE = 2 // render at 2x for a crisp shareable image
const iconCache = new Map<string, string>()

async function toDataUrl(url: string): Promise<string | null> {
  if (iconCache.has(url)) return iconCache.get(url)!
  try {
    const res = await net.fetch(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > 3_000_000) return null
    const type = res.headers.get('content-type') || 'image/png'
    const data = `data:${type};base64,${buf.toString('base64')}`
    if (iconCache.size < 600) iconCache.set(url, data)
    return data
  } catch {
    return null
  }
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

async function buildHtml(spec: TierSpec): Promise<string> {
  // resolve every icon to a data URL (no CORS tainting, loads instantly, any board size)
  const urls = new Set<string>()
  for (const t of spec.tiers) for (const s of t.skins) if (s.icon) urls.add(s.icon)
  const map = new Map<string, string | null>()
  await Promise.all([...urls].map(async (u) => map.set(u, await toDataUrl(u))))

  const rows = spec.tiers
    .map((t) => {
      const cards = t.skins
        .map((s) => {
          const data = s.icon ? map.get(s.icon) : null
          const img = data ? `<img src="${data}" alt="">` : `<div class="noimg">NO IMAGE</div>`
          return `<div class="card">${img}<div class="cn">${esc(s.name)}</div><div class="cw">${esc(s.weapon)}</div></div>`
        })
        .join('')
      return `<div class="row"><div class="lbl" style="background:${esc(t.color)}">${esc(t.label)}</div><div class="cards">${cards || '<div class="empty">—</div>'}</div></div>`
    })
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; box-sizing: border-box; }
    html { zoom: ${SCALE}; }
    body { width: 1160px; background: #0b0f17; color: #ece8e1; font-family: "Noto Sans JP","Yu Gothic UI","Meiryo",sans-serif;
      background-image: linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px); background-size: 32px 32px; }
    .wrap { padding: 28px 32px 34px; }
    .head { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #ff4655; padding-bottom: 14px; margin-bottom: 18px; }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand .mk { width: 26px; height: 26px; }
    .brand .t1 { font-weight: 900; font-size: 15px; letter-spacing: .14em; }
    .brand .t2 { font-size: 11px; color: #8b97aa; letter-spacing: .1em; }
    .title { font-weight: 900; font-size: 26px; text-align: right; max-width: 620px; }
    .date { font-size: 12px; color: #8b97aa; text-align: right; margin-top: 2px; }
    .row { display: flex; align-items: stretch; border: 1px solid #243045; border-top: none; min-height: 104px; }
    .row:first-of-type { border-top: 1px solid #243045; }
    .lbl { width: 92px; flex: none; display: grid; place-items: center; font-weight: 900; font-size: 34px; color: #0b0f17; font-family: "Bahnschrift","Segoe UI",sans-serif; }
    .cards { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px; align-content: flex-start; background: #0f1520; flex: 1; }
    .card { width: 150px; background: linear-gradient(180deg,#131b28,#0d131d); border: 1px solid #243045; padding: 6px 6px 8px; }
    .card img { width: 100%; height: 56px; object-fit: contain; display: block; }
    .card .noimg { height: 56px; display: grid; place-items: center; font-size: 10px; color: #3a4860; }
    .card .cn { font-size: 11px; font-weight: 700; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card .cw { font-size: 10px; color: #8b97aa; }
    .empty { color: #3a4860; align-self: center; padding-left: 8px; }
    .foot { margin-top: 14px; font-size: 11px; color: #8b97aa; display: flex; justify-content: space-between; }
  </style></head><body><div class="wrap">
    <div class="head">
      <div class="brand">
        <svg class="mk" viewBox="0 0 32 32"><path d="M16 4 28 16 16 28 4 16z" fill="none" stroke="#ff4655" stroke-width="2.4"/><path d="M16 1v6M16 25v6M1 16h6M25 16h6" stroke="#ece8e1" stroke-width="1.8"/><circle cx="16" cy="16" r="2.4" fill="#ff4655"/></svg>
        <div><div class="t1">STORE WATCHER</div><div class="t2">VALORANT スキン Tier表</div></div>
      </div>
      <div><div class="title">${esc(spec.title || 'スキン Tier表')}</div><div class="date">${esc(spec.dateLabel)}</div></div>
    </div>
    ${rows}
    <div class="foot"><span>VALORANT Store Watcher（非公式・Riot Gamesとは無関係）</span><span>store-watcher-guide.pages.dev</span></div>
  </div></body></html>`
}

/** Renders the tier list to a PNG using a hidden window (handles any board height). */
export async function renderTierImage(spec: TierSpec): Promise<Buffer> {
  const html = await buildHtml(spec)
  const win = new BrowserWindow({
    show: false,
    width: 1160 * SCALE,
    height: 900,
    useContentSize: true,
    webPreferences: { offscreen: false, sandbox: true, contextIsolation: true, nodeIntegration: false, images: true, javascript: true }
  })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    // wait for layout + data-URL images (which are already decoded)
    await win.webContents.executeJavaScript('(async()=>{await document.fonts.ready.catch(()=>{});await Promise.all([...document.images].map(i=>i.complete?0:new Promise(r=>{i.onload=i.onerror=r})));return document.documentElement.scrollHeight})()')
    const h = (await win.webContents.executeJavaScript('document.documentElement.scrollHeight')) as number
    win.setContentSize(1160 * SCALE, Math.max(200, Math.ceil(h)))
    await new Promise((r) => setTimeout(r, 120))
    const image = await win.webContents.capturePage()
    return image.toPNG()
  } finally {
    win.destroy()
  }
}
