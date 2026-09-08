import { EventEmitter } from 'node:events'
import { createHash, randomBytes, timingSafeEqual, scryptSync } from 'node:crypto'
import type { AppMode } from '@shared/types/term'
import type { ConfigService } from '@main/config/config-service'
import { SecureStore, secretKeys } from '@main/config/secure-store'

/**
 * 双形态状态机（硬约束 C-13 / C-14，需求 FR-6.1 / FR-6.2，任务 T0.11）
 *
 * public    仅 typeless 底座 + 扩展层
 * developer 额外解锁解题、全屏 OCR、防录屏、AI 聊天
 *
 * 隔离是三重的，本类只负责第一重（状态判定）：
 *   1) ModeService 状态 → 菜单/路由/快捷键按 mode 过滤
 *   2) IPC handler 在 public 下不注册（见 ipc/register.ts）
 *   3) 构建期 --public-only 裁剪产物（见 T4.3）
 */

/** 解锁需连点版本号的次数（FR-6.1） */
export const UNLOCK_CLICK_COUNT = 7
/** 连点计时窗口，超时归零 */
const CLICK_WINDOW_MS = 3000
/** 首次使用的默认口令，用户可在解锁后修改 */
const DEFAULT_PASSPHRASE = 'termlens-dev'

export class ModeService extends EventEmitter {
  private clickCount = 0
  private firstClickAt = 0
  private readonly secure: SecureStore

  constructor(
    private readonly config: ConfigService,
    secure?: SecureStore
  ) {
    super()
    this.secure = secure ?? new SecureStore()
  }

  get mode(): AppMode {
    const settings = this.config.getRaw()
    // 双保险：即使 settings.mode 被手工改成 developer，未解锁也不生效
    return settings.developer.unlocked && settings.mode === 'developer' ? 'developer' : 'public'
  }

  get isDeveloper(): boolean {
    return this.mode === 'developer'
  }

  get isUnlocked(): boolean {
    return this.config.getRaw().developer.unlocked
  }

  /**
   * 记录一次版本号点击。返回是否已达阈值、可弹出口令输入框。
   * 计时窗口内连点才累计，避免误触。
   */
  registerVersionClick(): { reachedThreshold: boolean; remaining: number } {
    const now = Date.now()
    if (now - this.firstClickAt > CLICK_WINDOW_MS) {
      this.clickCount = 0
      this.firstClickAt = now
    }
    this.clickCount++

    if (this.clickCount >= UNLOCK_CLICK_COUNT) {
      this.clickCount = 0
      return { reachedThreshold: true, remaining: 0 }
    }
    return { reachedThreshold: false, remaining: UNLOCK_CLICK_COUNT - this.clickCount }
  }

  /** 校验口令并解锁（FR-6.1） */
  unlock(passphrase: string): { ok: boolean; error?: string } {
    this.ensurePassphraseInitialized()
    if (!this.verifyPassphrase(passphrase)) {
      return { ok: false, error: '口令不正确' }
    }
    this.config.update({
      mode: 'developer',
      developer: { unlocked: true }
    })
    this.emit('changed', this.mode)
    return { ok: true }
  }

  /** 退回对外形态。仅切 mode，保留 unlocked 以便再次进入无需重输口令 */
  lock(): void {
    this.config.update({ mode: 'public' })
    this.emit('changed', this.mode)
  }

  /** 彻底重置为对外形态，清除解锁状态 */
  reset(): void {
    this.config.update({ mode: 'public', developer: { unlocked: false } })
    this.emit('changed', this.mode)
  }

  setPassphrase(passphrase: string): void {
    if (passphrase.length < 4) throw new Error('口令至少 4 个字符')
    this.secure.set(secretKeys.developerPassphraseHash(), hashPassphrase(passphrase))
  }

  private ensurePassphraseInitialized(): void {
    if (!this.secure.get(secretKeys.developerPassphraseHash())) {
      this.secure.set(secretKeys.developerPassphraseHash(), hashPassphrase(DEFAULT_PASSPHRASE))
    }
  }

  private verifyPassphrase(input: string): boolean {
    const stored = this.secure.get(secretKeys.developerPassphraseHash())
    if (!stored) return false
    return verifyPassphrase(input, stored)
  }
}

/** scrypt 加盐哈希，避免口令明文落盘 */
function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(passphrase, salt, 32)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

function verifyPassphrase(input: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    // 兼容早期可能存在的裸 sha256 格式
    const legacy = createHash('sha256').update(input).digest('hex')
    return safeEqual(legacy, stored)
  }
  const salt = Buffer.from(parts[1], 'hex')
  const expected = Buffer.from(parts[2], 'hex')
  const actual = scryptSync(input, salt, expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}
