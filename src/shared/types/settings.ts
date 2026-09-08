import type { AppMode, ExplanationLevel, TermMarkStyle, TriState } from './term'
import type { FeatureKey, ProviderConfig } from './provider'

/** 会议自动录制设置（FR-5） */
export interface MeetingSettings {
  /** 总开关：auto 自动检测并录制 / manual 仅提示 / off 完全关闭（FR-5.3） */
  mode: TriState
  recordAudio: boolean
  recordScreen: boolean
  /** 麦克风与系统声音可分别开关（FR-5.5） */
  captureMicrophone: boolean
  captureSystemAudio: boolean
  /** 自动模式下开始录制前的可取消倒计时秒数（FR-5.4） */
  countdownSeconds: number
  /** 音频静默多少秒判定会议结束（FR-5.6） */
  silenceStopSeconds: number
  /** 录制文件存储目录，用户可改（FR-5.7） */
  storageDir: string
  /** 存储上限 GB，超出按最旧优先清理（FR-5.7） */
  maxStorageGb: number
  /** 会议进程白名单（FR-5.1） */
  processWhitelist: string[]
  /** 是否已确认合规提示（FR-5.9） */
  complianceAcknowledged: boolean
  /** 录制结束后自动执行 转写 → 排版 → 术语标注（FR-5.8） */
  autoPostProcess: boolean
}

/** 术语识别与解释设置（FR-4） */
export interface TermSettings {
  enabled: boolean
  markStyle: TermMarkStyle
  level: ExplanationLevel
  /** 启用的领域词库，marxism 为首批重点（FR-4.8 / C-16） */
  enabledDomains: string[]
  /** 悬停多少毫秒后弹出简释（FR-4.3） */
  hoverDelayMs: number
  /** LLM 抽取的置信度下限，过滤误报 */
  minConfidence: number
  /** 是否允许调用 LLM 抽取（关闭则仅用本地词库，可完全离线 NFR-8） */
  allowLlmDetection: boolean
  /** 用户忽略的术语，不再标注 */
  ignoredTerms: string[]
}

/** 语音转写设置（FR-1） */
export interface TranscriptionSettings {
  hotkey: string
  language: string
  diarize: boolean
  streaming: boolean
}

/** 自动排版设置（FR-3） */
export interface FormattingSettings {
  defaultTemplate: 'meeting' | 'techdoc' | 'notes' | 'email' | 'social'
  removeFillers: boolean
  fixPunctuation: boolean
}

/** 开发者模式设置（FR-6，未解锁时不生效） */
export interface DeveloperSettings {
  unlocked: boolean
  /** 防录屏隐蔽，默认关闭（FR-6.7 / 决策 D5） */
  contentProtection: boolean
  /** 隐藏任务栏图标与 Alt+Tab（FR-6.8） */
  hideFromTaskbar: boolean
  solveHotkey: string
  overlayHotkey: string
  /** OCR 引擎偏好，auto 时优先 Windows 原生并自动降级（决策 D9） */
  ocrEngine: 'auto' | 'windows' | 'tesseract'
}

/** 跨设备同步设置（FR-8 / C-18） */
export interface SyncSettings {
  provider: 'none' | 'webdav' | 's3'
  endpoint: string
  username: string
  /** 与 API Key 同样经 safeStorage 加密 */
  secret: string
  bucket?: string
  /** 端到端加密口令 */
  passphrase: string
  autoSyncMinutes: number
}

export interface AppearanceSettings {
  theme: 'system' | 'light' | 'dark' | 'high-contrast'
  /** 色盲友好配色（NFR-7） */
  colorBlindSafe: boolean
  fontSize: number
}

export interface AppSettings {
  version: number
  mode: AppMode
  appearance: AppearanceSettings
  providers: ProviderConfig[]
  /** 功能级模型路由（FR-7.3） */
  featureBindings: Partial<Record<FeatureKey, string>>
  term: TermSettings
  transcription: TranscriptionSettings
  formatting: FormattingSettings
  meeting: MeetingSettings
  developer: DeveloperSettings
  sync: SyncSettings
}
