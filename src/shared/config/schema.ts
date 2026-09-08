import { z } from 'zod'

/**
 * 配置 schema 与默认值（任务 T0.8）
 * zod 同时用于 IPC 参数校验（NFR-6）。
 */

export const CONFIG_VERSION = 1

export const providerConfigSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(100),
  protocol: z.enum(['openai', 'anthropic', 'gemini']),
  baseUrl: z.string().max(2000).url().refine((value) => {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  }, '服务地址须使用 HTTPS；本机可用 HTTP，地址中不能包含凭据。'),
  apiKey: z.string().max(8192).default(''),
  model: z.string().min(1).max(200),
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
  maxRetries: z.number().int().min(0).max(10).default(2),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200000).optional(),
  supportsVision: z.boolean().optional()
})

export const providerModelsRequestSchema = providerConfigSchema
  .pick({ id: true, protocol: true, baseUrl: true, apiKey: true })
  .partial({ id: true })
  .extend({ baseUrl: z.string().trim().pipe(providerConfigSchema.shape.baseUrl) })
  .strict()

export const appearanceSchema = z.object({
  theme: z.enum(['system', 'light', 'dark', 'high-contrast']).default('system'),
  colorBlindSafe: z.boolean().default(false),
  fontSize: z.number().int().min(12).max(24).default(15)
})

export const termSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  markStyle: z.enum(['deepen', 'outline']).default('deepen'),
  level: z.enum(['beginner', 'intermediate', 'expert']).default('intermediate'),
  enabledDomains: z.array(z.string()).default(['marxism', 'ai', 'economics', 'philosophy']),
  hoverDelayMs: z.number().int().min(0).max(2000).default(300),
  minConfidence: z.number().min(0).max(1).default(0.6),
  allowLlmDetection: z.boolean().default(true),
  ignoredTerms: z.array(z.string()).default([]),
  selectionAuto: z.boolean().default(false),
  assistantPaused: z.boolean().default(false),
  selectionHotkey: z.string().max(100).default('Control+Shift+Space')
  ,maxNestedDepth: z.number().int().min(1).max(20).default(10)
})

export const transcriptionSettingsSchema = z.object({
  hotkey: z.string().default('Control+Shift+D'),
  language: z.string().default('auto'),
  diarize: z.boolean().default(false),
  streaming: z.boolean().default(true)
})

export const formattingSettingsSchema = z.object({
  defaultTemplate: z.enum(['meeting', 'techdoc', 'notes', 'email', 'social']).default('notes'),
  removeFillers: z.boolean().default(true),
  fixPunctuation: z.boolean().default(true)
})

export const meetingSettingsSchema = z.object({
  mode: z.enum(['auto', 'manual', 'off']).default('manual'),
  recordAudio: z.boolean().default(true),
  recordScreen: z.boolean().default(false),
  captureMicrophone: z.boolean().default(true),
  captureSystemAudio: z.boolean().default(true),
  countdownSeconds: z.number().int().min(0).max(60).default(5),
  silenceStopSeconds: z.number().int().min(10).max(600).default(60),
  storageDir: z.string().default(''),
  maxStorageGb: z.number().min(1).max(2000).default(20),
  processWhitelist: z
    .array(z.string())
    .default([
      'Zoom.exe',
      'Teams.exe',
      'ms-teams.exe',
      'feishu.exe',
      'Lark.exe',
      'DingTalk.exe',
      'wemeetapp.exe',
      'WeChat.exe',
      'Weixin.exe',
      'slack.exe',
      'webexmta.exe'
    ]),
  complianceAcknowledged: z.boolean().default(false),
  autoPostProcess: z.boolean().default(true)
})

export const developerSettingsSchema = z.object({
  unlocked: z.boolean().default(false),
  contentProtection: z.boolean().default(false),
  hideFromTaskbar: z.boolean().default(false),
  solveHotkey: z.string().default('Control+Shift+S'),
  overlayHotkey: z.string().default('Control+Shift+O'),
  ocrEngine: z.enum(['auto', 'windows', 'tesseract']).default('auto')
})

export const syncSettingsSchema = z.object({
  provider: z.enum(['none', 'webdav', 's3']).default('none'),
  endpoint: z.string().default(''),
  username: z.string().default(''),
  secret: z.string().default(''),
  bucket: z.string().optional(),
  passphrase: z.string().default(''),
  autoSyncMinutes: z.number().int().min(0).max(1440).default(0)
})

export const appSettingsSchema = z.object({
  version: z.number().int().default(CONFIG_VERSION),
  mode: z.enum(['public', 'developer']).default('public'),
  appearance: appearanceSchema.default({}),
  providers: z.array(providerConfigSchema).max(20).refine((items) => new Set(items.map((item) => item.id)).size === items.length, '服务 ID 不能重复').default([]),
  featureBindings: z.record(z.string()).default({}),
  term: termSettingsSchema.default({}),
  transcription: transcriptionSettingsSchema.default({}),
  formatting: formattingSettingsSchema.default({}),
  meeting: meetingSettingsSchema.default({}),
  developer: developerSettingsSchema.default({}),
  sync: syncSettingsSchema.default({})
})

export type AppSettingsParsed = z.infer<typeof appSettingsSchema>

/** 敏感字段路径，落盘时需剥离并交由 safeStorage 单独加密（FR-7.5 / 决策 D10） */
export const SECRET_PATHS = ['providers[].apiKey', 'sync.secret', 'sync.passphrase'] as const

export function createDefaultSettings(): AppSettingsParsed {
  return appSettingsSchema.parse({})
}
