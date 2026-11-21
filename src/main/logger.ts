import fs from 'node:fs'
import path from 'node:path'
import { redact } from '../core/util/redact'

/** Small file logger. Every line passes through redact() so tokens/webhook URLs never reach disk. */
export class Logger {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true })
  }
  get file(): string {
    return path.join(this.dir, 'app.log')
  }
  private write(level: string, msg: unknown, extra?: unknown): void {
    const line = `${new Date().toISOString()} [${level}] ${redact(msg)}${extra !== undefined ? ' ' + redact(extra) : ''}\n`
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 1_000_000) fs.renameSync(this.file, path.join(this.dir, 'app.old.log'))
      fs.appendFileSync(this.file, line)
    } catch {
      /* logging must never crash the app */
    }
    if (process.env.NODE_ENV === 'development') process.stdout.write(line)
  }
  info(m: unknown, e?: unknown): void {
    this.write('INFO', m, e)
  }
  warn(m: unknown, e?: unknown): void {
    this.write('WARN', m, e)
  }
  error(m: unknown, e?: unknown): void {
    this.write('ERROR', m, e)
  }
  tail(lines = 200): string {
    try {
      return fs.readFileSync(this.file, 'utf8').split('\n').slice(-lines).join('\n')
    } catch {
      return ''
    }
  }
}
