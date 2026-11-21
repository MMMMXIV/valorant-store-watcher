import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

/**
 * Secret storage using Electron safeStorage. On Windows this is DPAPI
 * (CryptProtectData, bound to the logged-in Windows user). Values are never
 * stored in plaintext; if encryption is unavailable, saving is refused.
 * The renderer never receives secret values — only "configured" flags.
 */
export class SecretStore {
  private cache: Record<string, string> | null = null

  constructor(private file: string) {}

  private load(): Record<string, string> {
    if (this.cache) return this.cache
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.cache ?? {}), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  set(key: string, value: string): void {
    if (!this.available()) throw new Error('OSの暗号化機能が利用できないため、秘密情報を保存できません')
    this.load()[key] = safeStorage.encryptString(value).toString('base64')
    this.save()
  }

  get(key: string): string | null {
    const v = this.load()[key]
    if (!v || !this.available()) return null
    try {
      return safeStorage.decryptString(Buffer.from(v, 'base64'))
    } catch {
      return null
    }
  }

  has(key: string): boolean {
    return !!this.load()[key]
  }

  delete(key: string): void {
    delete this.load()[key]
    this.save()
  }
}
