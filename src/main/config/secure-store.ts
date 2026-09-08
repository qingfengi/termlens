import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 敏感信息加密存储（需求 FR-7.5 / 决策 D10 / 任务 T0.9）
 *
 * API Key、同步凭证、E2E 口令一律经 Electron safeStorage（Windows 下走 DPAPI）
 * 加密后落盘，禁止明文。明文仅存在于主进程内存，绝不下发渲染进程。
 */

interface SecretBundle {
  version: number
  /** key -> base64 of platform-encrypted bytes. */
  entries: Record<string, string>
  encrypted: boolean
}

const SECRET_FILE = 'secrets.dat'

export class SecureStore {
  private cache = new Map<string, string>()
  private encryptionAvailable = false
  private loaded = false

  constructor(private readonly filePath: string = join(app.getPath('userData'), SECRET_FILE)) {}

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    this.encryptionAvailable = safeStorage.isEncryptionAvailable()

    if (!existsSync(this.filePath)) return

    try {
      const bundle = JSON.parse(readFileSync(this.filePath, 'utf8')) as SecretBundle
      if (!bundle.encrypted) {
        console.warn('[SecureStore] 旧凭据文件未加密，请重新填写凭据。')
        return
      }
      for (const [key, value] of Object.entries(bundle.entries ?? {})) {
        try {
          const buf = Buffer.from(value, 'base64')
          const plain = safeStorage.decryptString(buf)
          this.cache.set(key, plain)
        } catch {
          // 单条解密失败（如换了机器 / 换了用户账户）不应拖垮整个配置加载
          console.warn(`[SecureStore] 无法解密条目 ${key}，已跳过。需重新填写该凭证。`)
        }
      }
    } catch {
      console.error('[SecureStore] 密钥文件损坏，已忽略。')
    }
  }

  get(key: string): string {
    this.ensureLoaded()
    return this.cache.get(key) ?? ''
  }

  set(key: string, value: string): void {
    this.updateBatch({ [key]: value })
  }

  delete(key: string): void {
    this.updateBatch({ [key]: '' })
  }

  /** 删除所有以 prefix 开头的条目，用于移除 Provider 时清理其 Key */
  deleteByPrefix(prefix: string): void {
    this.updateBatch({}, [prefix])
  }

  /** 普通保存失败时恢复原密文；两个文件之间的断电事务不由文件重命名保证。 */
  updateBatch(
    values: Record<string, string>,
    deletePrefixes: readonly string[] = [],
    commit: () => void = () => {}
  ): void {
    this.ensureLoaded()
    const next = new Map(this.cache)
    for (const key of next.keys()) {
      if (deletePrefixes.some((prefix) => key.startsWith(prefix))) next.delete(key)
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === '') next.delete(key)
      else next.set(key, value)
    }

    const previousFile = existsSync(this.filePath) ? readFileSync(this.filePath) : undefined
    // 加密和写入均针对副本，整个批次成功以前不修改内存中的有效凭据。
    this.persist(next)
    try {
      commit()
    } catch (error) {
      try {
        // 直接恢复原密文，避免回滚再次依赖平台加密服务。
        if (previousFile) this.writeBundle(previousFile)
        else unlinkSync(this.filePath)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], '配置保存失败，原凭据恢复也失败，请检查存储后重试。')
      }
      throw error
    }
    this.cache = next
  }

  get isEncrypted(): boolean {
    this.ensureLoaded()
    return this.encryptionAvailable
  }

  private persist(cache: Map<string, string>): void {
    const entries: Record<string, string> = {}
    for (const [key, plain] of cache) {
      if (!this.encryptionAvailable) throw new Error('系统加密不可用，无法保存密钥。')
      entries[key] = safeStorage.encryptString(plain).toString('base64')
    }

    const bundle: SecretBundle = {
      version: 1,
      entries,
      encrypted: true
    }

    this.writeBundle(JSON.stringify(bundle))
  }

  private writeBundle(bundle: string | Buffer): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    // 每个文件先写临时文件再改名，避免普通写入失败损坏原文件。
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, bundle, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.filePath)
  }
}

/** 密钥命名约定，与 SECRET_PATHS 对应 */
export const secretKeys = {
  providerApiKey: (providerId: string): string => `provider.${providerId}.apiKey`,
  syncSecret: (): string => 'sync.secret',
  syncPassphrase: (): string => 'sync.passphrase',
  developerPassphraseHash: (): string => 'developer.passphraseHash'
} as const
