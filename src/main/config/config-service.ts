import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appSettingsSchema,
  createDefaultSettings,
  type AppSettingsParsed
} from '@shared/config/schema'
import type { ProviderConfig } from '@shared/types/provider'
import { SecureStore, secretKeys } from './secure-store'

/**
 * 配置中心 - plain version
 *
 * 职责划分：
 * - 非敏感配置 → settings.json 明文（便于用户手工检查与备份）
 * - 敏感凭证   → SecureStore 加密（FR-7.5）
 *
 * 对渲染进程暴露时，apiKey / secret / passphrase 一律替换为掩码，
 * 明文永不越过 IPC 边界（NFR-6）。
 */

const SETTINGS_FILE = 'settings.json'
/** 渲染进程看到的占位符；回写时若仍为此值则表示"未修改"，保留原 Key */
export const MASKED = '••••••••'

export class ConfigService extends EventEmitter {
  private settings: AppSettingsParsed
  private readonly secure: SecureStore

  constructor(
    private readonly filePath = join(app.getPath('userData'), SETTINGS_FILE),
    secure?: SecureStore
  ) {
    super()
    this.secure = secure ?? new SecureStore()
    this.settings = this.load()
  }

  private load(): AppSettingsParsed {
    let raw: unknown = {}
    if (existsSync(this.filePath)) {
      try {
        raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
      } catch {
        console.error('[ConfigService] settings.json 解析失败，回退默认配置。')
        raw = {}
      }
    }

    const parsed = appSettingsSchema.safeParse(raw)
    const settings = parsed.success ? parsed.data : createDefaultSettings()
    if (!parsed.success) {
      console.warn('[ConfigService] 配置校验失败，已回退默认值。')
    }

    // 录制目录默认值依赖运行时路径，schema 里无法写死
    if (!settings.meeting.storageDir) {
      settings.meeting.storageDir = join(app.getPath('videos'), 'TermLens')
    }

    // 注入加密存储中的敏感值
    for (const provider of settings.providers) {
      provider.apiKey = this.secure.get(secretKeys.providerApiKey(provider.id))
    }
    settings.sync.secret = this.secure.get(secretKeys.syncSecret())
    settings.sync.passphrase = this.secure.get(secretKeys.syncPassphrase())

    return settings
  }

  /** 主进程内部使用，含明文凭证 */
  getRaw(): AppSettingsParsed {
    return this.settings
  }

  /** 供渲染进程使用，敏感字段已掩码（NFR-6） */
  getSafe(): AppSettingsParsed {
    const clone = structuredClone(this.settings)
    for (const provider of clone.providers) {
      provider.apiKey = provider.apiKey ? MASKED : ''
    }
    clone.sync.secret = clone.sync.secret ? MASKED : ''
    clone.sync.passphrase = clone.sync.passphrase ? MASKED : ''
    return clone
  }

  getProvider(id: string): ProviderConfig | undefined {
    return this.settings.providers.find((p) => p.id === id)
  }

  /** 按功能路由取 Provider（FR-7.3）；未绑定时回退到第一个可用 Provider */
  resolveProviderFor(feature: string): ProviderConfig | undefined {
    const boundId = this.settings.featureBindings[feature as keyof AppSettingsParsed['featureBindings']]
    if (boundId) {
      const found = this.getProvider(boundId)
      if (found) return found
    }
    return this.settings.providers[0]
  }

  /** 深合并更新；掩码值视为"未修改" */
  update(patch: DeepPartial<AppSettingsParsed>): AppSettingsParsed {
    const merged = deepMerge(structuredClone(this.settings), patch)

    // 掩码回写保护：UI 传回掩码说明用户没改这个字段
    for (const provider of merged.providers ?? []) {
      if (provider.apiKey === MASKED) {
        provider.apiKey = this.secure.get(secretKeys.providerApiKey(provider.id))
      }
    }
    if (merged.sync.secret === MASKED) merged.sync.secret = this.secure.get(secretKeys.syncSecret())
    if (merged.sync.passphrase === MASKED) {
      merged.sync.passphrase = this.secure.get(secretKeys.syncPassphrase())
    }

    const parsed = appSettingsSchema.safeParse(merged)
    if (!parsed.success) {
      throw new Error(`配置校验失败：${parsed.error.issues.map((i) => i.message).join('; ')}`)
    }

    const previous = this.settings
    this.settings = parsed.data
    try { this.persist(previous) } catch (error) { this.settings = previous; throw error }
    this.emit('changed', this.getSafe())
    return this.getSafe()
  }

  upsertProvider(config: ProviderConfig): AppSettingsParsed {
    const providers = [...this.settings.providers]
    const index = providers.findIndex((p) => p.id === config.id)
    const resolved: ProviderConfig = {
      ...config,
      apiKey:
        config.apiKey === MASKED ? this.secure.get(secretKeys.providerApiKey(config.id)) : config.apiKey
    }
    if (index === -1) providers.push(resolved)
    else providers[index] = resolved

    return this.update({ providers } as DeepPartial<AppSettingsParsed>)
  }

  removeProvider(id: string): AppSettingsParsed {
    const providers = this.settings.providers.filter((p) => p.id !== id)

    // 清理指向已删除 Provider 的功能绑定，避免留下悬空引用
    const bindings = { ...this.settings.featureBindings }
    for (const [feature, providerId] of Object.entries(bindings)) {
      if (providerId === id) delete bindings[feature as keyof typeof bindings]
    }

    const previous = this.settings
    this.settings = { ...previous, providers, featureBindings: bindings }
    try { this.persist(previous) } catch (error) { this.settings = previous; throw error }
    this.emit('changed', this.getSafe())
    return this.getSafe()
  }

  get secretsEncrypted(): boolean {
    return this.secure.isEncrypted
  }

  private persist(previous: AppSettingsParsed): void {
    // 凭据一次提交，主配置写入失败时由 SecureStore 恢复原密文。
    const secrets: Record<string, string> = {}
    for (const provider of this.settings.providers) {
      secrets[secretKeys.providerApiKey(provider.id)] = provider.apiKey
    }
    secrets[secretKeys.syncSecret()] = this.settings.sync.secret
    secrets[secretKeys.syncPassphrase()] = this.settings.sync.passphrase
    const removedPrefixes = previous.providers
      .filter((provider) => !this.settings.providers.some((current) => current.id === provider.id))
      .map((provider) => `provider.${provider.id}.`)

    const onDisk = structuredClone(this.settings)
    for (const provider of onDisk.providers) provider.apiKey = ''
    onDisk.sync.secret = ''
    onDisk.sync.passphrase = ''

    this.secure.updateBatch(secrets, removedPrefixes, () => {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(onDisk, null, 2), 'utf8')
      renameSync(tmp, this.filePath)
    })
  }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深合并：数组整体替换（Provider 列表按整体提交），对象递归合并 */
function deepMerge<T>(target: T, patch: DeepPartial<T>): T {
  if (!isPlainObject(patch)) return target
  const result = target as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('配置字段无效。')
    if (value === undefined) continue
    const current = result[key]
    if (isPlainObject(value) && isPlainObject(current)) {
      result[key] = deepMerge(current, value as DeepPartial<typeof current>)
    } else {
      result[key] = value
    }
  }
  return result as T
}
