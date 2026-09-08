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
 * OpenAI 兼容协议适配器（FR-7.1）
 *
 * 覆盖 OpenAI、DeepSeek、Kimi、通义、智谱、硅基流动，
 * 以及本地 Ollama / LM Studio（FR-7.6）。
 * baseUrl 与 apiKey 全部由用户配置（硬约束 C-08）。
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly protocol = 'openai' as const

  constructor(private readonly config: ProviderConfig) {}

  get id(): string {
    return this.config.id
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    // 本地 Ollama 常无需 Key，故为空时不发 Authorization 头
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey}`
    return h
  }

  private toPayload(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages: req.messages.map(toOpenAIMessage),
      stream
    }
    const temperature = req.temperature ?? this.config.temperature
    if (temperature !== undefined) payload.temperature = temperature
    const maxTokens = req.maxTokens ?? this.config.maxTokens
    if (maxTokens !== undefined) payload.max_tokens = maxTokens
    if (req.jsonMode) payload.response_format = { type: 'json_object' }
    if (stream) payload.stream_options = { include_usage: true }
    return payload
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    let res: Response
    try {
      res = await requestWithRetry({
        url: joinUrl(this.config.baseUrl, 'chat/completions'),
        headers: this.headers(),
        body: this.toPayload(req, true),
        timeoutMs: this.config.timeoutMs,
        maxRetries: this.config.maxRetries,
        signal: req.signal
      })
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
      return
    }

    try {
      for await (const { data } of parseSse(res)) {
        if (data === '[DONE]') break
        let parsed: OpenAIStreamChunk
        try {
          parsed = JSON.parse(data) as OpenAIStreamChunk
        } catch {
          continue
        }
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) yield { type: 'delta', text: delta }
        if (parsed.usage) {
          yield {
            type: 'done',
            usage: {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0
            }
          }
          return
        }
      }
      yield { type: 'done' }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }

  async test(): Promise<TestResult> {
    const started = Date.now()
    try {
      const res = await requestWithRetry({
        url: joinUrl(this.config.baseUrl, 'chat/completions'),
        headers: this.headers(),
        body: {
          model: this.config.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
          stream: false
        },
        timeoutMs: Math.min(this.config.timeoutMs, 20000),
        maxRetries: 0
      })
      const json = (await res.json()) as { model?: string }
      return { ok: true, latencyMs: Date.now() - started, model: json.model ?? this.config.model }
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof ProviderError ? err.message : String(err)
      }
    }
  }
}

function toOpenAIMessage(msg: ChatMessage): Record<string, unknown> {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content }
  }
  return {
    role: msg.role,
    content: msg.content.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
    )
  }
}

interface OpenAIStreamChunk {
  choices?: Array<{ delta?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}
