/**
 * IPC 通道单一来源（design.md 第 2 节 / 任务 T0.7）
 *
 * 关键设计：PUBLIC_CHANNELS 与 DEVELOPER_CHANNELS 严格分离。
 * public 形态下 DEVELOPER_CHANNELS 的 handler 根本不注册，
 * 即使渲染进程被篡改去调用也会直接失败（C-14 三重保险之一）。
 */

export const PUBLIC_CHANNELS = {
  // 配置中心（FR-7）
  configGet: 'config:get',
  configUpdate: 'config:update',
  providerTest: 'provider:test',
  providerList: 'provider:list',
  providerUpsert: 'provider:upsert',
  providerRemove: 'provider:remove',

  // 形态（FR-6.1）
  modeGet: 'mode:get',
  modeUnlock: 'mode:unlock',
  modeLock: 'mode:lock',

  // 术语引擎（FR-4）
  termDetect: 'term:detect',
  termBrief: 'term:brief',
  termDetail: 'term:detail',
  termFollowup: 'term:followup',
  termThread: 'term:thread',
  termHistory: 'term:history',
  termIgnore: 'term:ignore',
  termCustomUpsert: 'term:customUpsert',
  termLexiconDomains: 'term:lexiconDomains',
  readerList: 'reader:list',
  readerSave: 'reader:save',
  readerDelete: 'reader:delete',
  selectionGet: 'selection:get',
  selectionConfigure: 'selection:configure',
  selectionOpenManager: 'selection:openManager',
  selectionHide: 'selection:hide',

  // 语音转写（FR-1）
  asrStart: 'asr:start',
  asrStop: 'asr:stop',
  asrTranscribeFile: 'asr:transcribeFile',
  transcriptList: 'transcript:list',
  transcriptGet: 'transcript:get',

  // 自动排版（FR-3）
  formatRun: 'format:run',
  formatExport: 'format:export',

  // 题目学习（FR-2）
  studySolve: 'study:solve',
  studyKeyPoints: 'study:keyPoints',
  studyPractice: 'study:practice',
  studyHistory: 'study:history',

  // 会议录制（FR-5）
  meetingStatus: 'meeting:status',
  meetingStart: 'meeting:start',
  meetingStop: 'meeting:stop',
  meetingCancelCountdown: 'meeting:cancelCountdown',
  recordingList: 'recording:list',

  // 同步（FR-8）
  syncExport: 'sync:export',
  syncImport: 'sync:import',
  syncNow: 'sync:now',

  // 窗口
  windowMinimize: 'window:minimize',
  windowClose: 'window:close'
} as const

export const DEVELOPER_CHANNELS = {
  // 自动解题（FR-6.3 / 6.4）
  solveCapture: 'dev:solve:capture',
  solveQueue: 'dev:solve:queue',
  solveHistory: 'dev:solve:history',

  // 全屏 OCR 术语标注（FR-6.5 / 6.6）
  overlayToggle: 'dev:overlay:toggle',
  overlayScan: 'dev:overlay:scan',
  overlaySetInteractive: 'dev:overlay:setInteractive',

  // 防录屏（FR-6.7 / 6.8）
  protectionSet: 'dev:protection:set',

  // AI 聊天客户端（FR-6.9）
  chatSend: 'dev:chat:send',
  chatSessions: 'dev:chat:sessions',

  // Prompt 调试台（FR-6.10）
  promptInspect: 'dev:prompt:inspect'
} as const

/** 主进程 → 渲染进程的推送事件 */
export const EVENTS = {
  modeChanged: 'evt:mode:changed',
  configChanged: 'evt:config:changed',
  asrChunk: 'evt:asr:chunk',
  llmChunk: 'evt:llm:chunk',
  termsFound: 'evt:term:found',
  meetingDetected: 'evt:meeting:detected',
  meetingCountdown: 'evt:meeting:countdown',
  recordingState: 'evt:recording:state',
  overlayTerms: 'evt:overlay:terms',
  solveResult: 'evt:solve:result',
  toast: 'evt:toast'
} as const

export type PublicChannel = (typeof PUBLIC_CHANNELS)[keyof typeof PUBLIC_CHANNELS]
export type DeveloperChannel = (typeof DEVELOPER_CHANNELS)[keyof typeof DEVELOPER_CHANNELS]
export type AppEvent = (typeof EVENTS)[keyof typeof EVENTS]

export const ALL_INVOKE_CHANNELS: readonly string[] = [
  ...Object.values(PUBLIC_CHANNELS),
  ...Object.values(DEVELOPER_CHANNELS)
]

export const ALL_EVENT_CHANNELS: readonly string[] = Object.values(EVENTS)
