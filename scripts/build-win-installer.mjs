// Builds the Windows installer WITHOUT Wine:
//   1) electron-builder --win --dir  → release/win-unpacked (exe icon/metadata edited natively)
//   2) native makensis compiles build/installer.nsi (uninstaller is written at install time)
// On Windows you can simply use `npm run dist:win` instead.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })

if (!process.argv.includes('--skip-pack')) {
  run('npx', ['electron-vite', 'build'])
  run('npx', ['electron-builder', '--win', '--x64', '--dir'])
}
const src = path.join(root, 'release', 'win-unpacked')
if (!fs.existsSync(path.join(src, 'VALORANT Store Watcher.exe'))) throw new Error('release/win-unpacked が見つかりません')
const out = path.join(root, 'release', `VALORANT-Store-Watcher-Setup-${pkg.version}.exe`)
run('makensis', ['-V2', `-DVERSION=${pkg.version}`, `-DSRCDIR=${src}`, `-DOUTFILE=${out}`, path.join(root, 'build', 'installer.nsi')], { cwd: path.join(root, 'build') })
console.log(`\n✔ Installer: ${path.relative(root, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`)
