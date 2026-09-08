/**
 * LLM / ASR Provider 抽象层类型（需求 FR-7，决策 D4）
 *
 * 三套协议：OpenAI 兼容、Anthropic 原生、Gemini 原生。
 * 硬约束 C-08：apiKey / baseUrl / model 全部用户可改。
 *
 * 本文件与 Electron 完全解耦，供未来手机端直接复用（NFR-9）。
 */

export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini'

/** 需要 LLM 能力的功能点，用于功能级路由（FR-7.3） */
export type FeatureKey =
  | 'termBrief' // 术语简释，建议绑便宜快模型
  | 'termDetail' // 术语详解
  | 'termFollowup' // 术语追问
  | 'study' // 题目学习（讲解式）
  | 'format' // 自动排版
  | 'solve' // 自动解题（开发者模式，建议绑视觉/强模型）
  | 'chat' // AI 聊天客户端
  | 'asr' // 语音转写

export interface ProviderConfig {
  id: string
  name: string
  protocol: ProviderProtocol
  /** 用户可改，支持 Ollama / LM Studio 等本地端点（FR-7.6） */
  baseUrl: string
  /** 明文仅在主进程内存中出现，落盘经 safeStorage 加密（FR-7.5） */
  apiKey: string
  model: string
  timeoutMs: number
  maxRetries: number
  temperature?: number
  maxTokens?: number
  /** 是否具备图像输入能力，解题功能需要 */
  supportsVision?: boolean
}

export interface ChatMessageContentImage {
  type: 'image'
  /** base64 编码，不含 data URL 前缀 */
  data: string
  mimeType: string
}

export interface ChatMessageContentText {
  type: 'text'
  text: string
}

export type ChatMessageContent = ChatMessageContentText | ChatMessageContentImage

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatMessageContent[]
}

export interface ChatRequest {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** 要求模型返回严格 JSON，术语抽取依赖此项 */
  jsonMode?: boolean
  signal?: AbortSignal
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
}

/** 统一流式分片，三协议差异在适配器内部消化 */
export interface ChatChunk {
  type: 'delta' | 'done' | 'error'
  text?: string
  usage?: ChatUsage
  error?: string
}

export interface TestResult {
  ok: boolean
  latencyMs?: number
  model?: string
  error?: string
}

export interface ChatProvider {
  readonly id: string
  readonly protocol: ProviderProtocol
  chat(req: ChatRequest): AsyncIterable<ChatChunk>
  /** 连接测试（FR-7.4） */
  test(): Promise<TestResult>
}

export interface TranscriptChunk {
  type: 'delta' | 'done' | 'error'
  text?: string
  /** 说话人标签（FR-1.8） */
  speaker?: string
  startMs?: number
  endMs?: number
  error?: string
}

export interface AsrRequest {
  /** 音频原始字节 */
  audio: Uint8Array
  mimeType: string
  /** 语言提示，空则自动检测（FR-1.6 中英混说） */
  language?: string
  diarize?: boolean
  signal?: AbortSignal
}

export interface AsrProvider {
  readonly id: string
  transcribe(req: AsrRequest): AsyncIterable<TranscriptChunk>
  test(): Promise<TestResult>
}
