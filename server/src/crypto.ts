import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM for Riot cookies at rest.
 * The key comes from the environment (VSW_SERVER_KEY), kept SEPARATE from the database,
 * so a leaked DB alone cannot be decrypted. Each record is bound to its owner via AAD
 * (the Discord user id), so a row cannot be transplanted to another user.
 */
export class SecretBox {
  private readonly key: Buffer

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64')
    if (key.length !== 32) throw new Error('VSW_SERVER_KEY は base64 の 32 バイト鍵である必要があります')
    this.key = key
  }

  static generateKey(): string {
    return randomBytes(32).toString('base64')
  }

  /** Returns a compact "iv.tag.ciphertext" base64url string. */
  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(aad, 'utf8'))
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.')
  }

  decrypt(packed: string, aad: string): string {
    const [ivB, tagB, ctB] = packed.split('.')
    if (!ivB || !tagB || !ctB) throw new Error('暗号文の形式が不正です')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64url'))
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8')
  }
}
