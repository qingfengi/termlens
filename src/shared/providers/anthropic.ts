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
 * Anthropic 原生协议适配器（FR-7.1 / 决策 D4）
 *
 * 与 OpenAI 的差异由本适配器内部消化：
 * - 端点 /v1/messages
 * - 鉴权头 x-api-key + anthropic-version
 * - system 提示为顶层字段，不放在 messages 里
 * - 图像为 source.base64 结构
 */
const ANTHROPIC_VERSION = '2023-06-01'

export class AnthropicProvider implements ChatProvider {
  readonly protocol = 'anthropic' as const

  constructor(private readonly config: ProviderConfig) {}

  get id(): string {
    return this.config.id
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    }
  }

  private toPayload(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const systemParts: string[] = []
    const messages: Array<Record<string, unknown>> = []

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        systemParts.push(typeof msg.content === 'string' ? msg.content : flattenText(msg))
        continue
      }
      messages.push({ role: msg.role, content: toAnthropicContent(msg) })
    }

    // Anthropic 无原生 JSON mode，用 system 指令约束（extractJson 兜底解析）
    if (req.jsonMode) {
      systemParts.push('只输出合法 JSON，不要任何解释文字，不要使用 Markdown 代码围栏。')
    }

    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages,
      // max_tokens 是 Anthropic 必填项，给稳妥默认值
      max_tokens: req.maxTokens ?? this.config.maxTokens ?? 4096,
      stream
    }
    if (systemParts.length > 0) payload.system = systemParts.join('\n\n')
    const temperature = req.temperature ?? this.config.temperature
    if (temperature !== undefined) payload.temperature = temperature
    return payload
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    let res: Response
    try {
      res = await requestWithRetry({
        url: joinUrl(this.config.baseUrl, 'v1/messages'),
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

    let promptTokens = 0
    let completionTokens = 0

    try {
      for await (const { data } of parseSse(res)) {
        let evt: AnthropicStreamEvent
        try {
          evt = JSON.parse(data) as AnthropicStreamEvent
        } catch {
          continue
        }

        switch (evt.type) {
          case 'message_start':
            promptTokens = evt.message?.usage?.input_tokens ?? 0
            break
          case 'content_block_delta':
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              yield { type: 'delta', text: evt.delta.text }
            }
            break
          case 'message_delta':
            completionTokens = evt.usage?.output_tokens ?? completionTokens
            break
          case 'error':
            yield { type: 'error', error: evt.error?.message ?? 'Anthropic 返回错误' }
            return
          case 'message_stop':
            yield { type: 'done', usage: { promptTokens, completionTokens } }
            return
          default:
            break
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
      const res = await requestWithRetry({
        url: joinUrl(this.config.baseUrl, 'v1/messages'),
        headers: this.headers(),
        body: {
          model: this.config.model,
          max_tokens: 4,
          messages: [{ role: 'user', content: 'ping' }]
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

function flattenText(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function toAnthropicContent(msg: ChatMessage): unknown {
  if (typeof msg.content === 'string') return msg.content
  return msg.content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image',
          source: { type: 'base64', media_type: part.mimeType, data: part.data }
        }
  )
}

interface AnthropicStreamEvent {
  type: string
  message?: { usage?: { input_tokens?: number } }
  delta?: { type?: string; text?: string }
  usage?: { output_tokens?: number }
  error?: { message?: string }
}
