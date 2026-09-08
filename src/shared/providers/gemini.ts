import type {
  ChatChunk,
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ProviderConfig,
  TestResult
} from '../types/provider'
import { joinUrl, parseSse, ProviderError, requestWithRetry } from './http'

/**
 * Gemini 原生协议适配器（FR-7.1 / 决策 D4）
 *
 * 与前两者的差异：
 * - 端点 /models/{model}:streamGenerateContent?alt=sse&key=API_KEY
 * - 鉴权走查询参数 key，不是请求头
 * - 角色 assistant → model，system 走 systemInstruction
 * - 内容为 parts[]，图像用 inlineData
 */
export class GeminiProvider implements ChatProvider {
  readonly protocol = 'gemini' as const

  constructor(private readonly config: ProviderConfig) {}

  get id(): string {
    return this.config.id
  }

  private endpoint(method: 'streamGenerateContent' | 'generateContent'): string {
    const base = joinUrl(this.config.baseUrl, `models/${this.config.model}:${method}`)
    const params = new URLSearchParams({ key: this.config.apiKey })
    if (method === 'streamGenerateContent') params.set('alt', 'sse')
    return `${base}?${params.toString()}`
  }

  private toPayload(req: ChatRequest): Record<string, unknown> {
    const systemParts: string[] = []
    const contents: Array<Record<string, unknown>> = []

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        systemParts.push(flattenText(msg))
        continue
      }
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: toGeminiParts(msg)
      })
    }

    const generationConfig: Record<string, unknown> = {}
    const temperature = req.temperature ?? this.config.temperature
    if (temperature !== undefined) generationConfig.temperature = temperature
    const maxTokens = req.maxTokens ?? this.config.maxTokens
    if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens
    if (req.jsonMode) generationConfig.responseMimeType = 'application/json'

    const payload: Record<string, unknown> = { contents }
    if (systemParts.length > 0) {
      payload.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] }
    }
    if (Object.keys(generationConfig).length > 0) payload.generationConfig = generationConfig
    return payload
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    let res: Response
    try {
      res = await requestWithRetry({
        url: this.endpoint('streamGenerateContent'),
        headers: { 'Content-Type': 'application/json' },
        body: this.toPayload(req),
        timeoutMs: this.config.timeoutMs,
        maxRetries: this.config.maxRetries,
        signal: req.signal
      })
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
      return
    }

    let promptTokens = 0
    let completionTokens = 0

    try {
      for await (const { data } of parseSse(res)) {
        let parsed: GeminiStreamChunk
        try {
          parsed = JSON.parse(data) as GeminiStreamChunk
        } catch {
          continue
        }
        if (parsed.error) {
          yield { type: 'error', error: parsed.error.message ?? 'Gemini 返回错误' }
          return
        }
        const parts = parsed.candidates?.[0]?.content?.parts ?? []
        for (const part of parts) {
          if (part.text) yield { type: 'delta', text: part.text }
        }
        if (parsed.usageMetadata) {
          promptTokens = parsed.usageMetadata.promptTokenCount ?? promptTokens
          completionTokens = parsed.usageMetadata.candidatesTokenCount ?? completionTokens
        }
      }
      yield { type: 'done', usage: { promptTokens, completionTokens } }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }

  async test(): Promise<TestResult> {
    const started = Date.now()
    try {
      await requestWithRetry({
        url: this.endpoint('generateContent'),
        headers: { 'Content-Type': 'application/json' },
        body: {
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 4 }
        },
        timeoutMs: Math.min(this.config.timeoutMs, 20000),
        maxRetries: 0
      })
      return { ok: true, latencyMs: Date.now() - started, model: this.config.model }
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof ProviderError ? err.message : String(err)
      }
    }
  }
}

function flattenText(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function toGeminiParts(msg: ChatMessage): Array<Record<string, unknown>> {
  if (typeof msg.content === 'string') return [{ text: msg.content }]
  return msg.content.map((part) =>
    part.type === 'text'
      ? { text: part.text }
      : { inlineData: { mimeType: part.mimeType, data: part.data } }
  )
}

interface GeminiStreamChunk {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  error?: { message?: string }
}
