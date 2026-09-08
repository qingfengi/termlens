import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAICompatibleProvider,
  collectText,
  extractJson
} from '../../src/shared/providers'
import { parseSse, requestWithRetry } from '../../src/shared/providers/http'
import type { ProviderConfig } from '../../src/shared/types/provider'

/** 任务 T0.19：三协议适配器 mock 测试 */

function baseConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    name: 'test',
    protocol: 'openai',
    baseUrl: 'https://example.test/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    timeoutMs: 5000,
    maxRetries: 0,
    ...overrides
  }
}

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `${l}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

function mockFetch(res: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => res)
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('request lifetime', () => {
  it('times out a body that stalls after successful response headers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream())))
    const response = await requestWithRetry({ url: 'https://example.test', headers: {}, timeoutMs: 30, maxRetries: 0 })
    await expect(response.text()).rejects.toThrow('超时')
  })
  it('does not send an already cancelled request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    controller.abort()
    await expect(requestWithRetry({ url: 'https://example.test', headers: {}, timeoutMs: 1000, maxRetries: 0, signal: controller.signal })).rejects.toThrow('取消')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('cancels a streaming body and rejects redirects instead of forwarding credentials', async () => {
    const fetch = vi.fn(async () => new Response(new ReadableStream()))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const response = await requestWithRetry({ url: 'https://example.test', headers: {}, timeoutMs: 1000, maxRetries: 0, signal: controller.signal })
    const text = response.text()
    controller.abort()
    await expect(text).rejects.toThrow('取消')
    expect(fetch.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ redirect: 'error' })])
  })
})

describe('OpenAI 兼容适配器', () => {
  it('解析流式增量并累计 usage', async () => {
    mockFetch(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"剩余"}}]}',
        'data: {"choices":[{"delta":{"content":"价值"}}]}',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":11,"completion_tokens":4}}',
        'data: [DONE]'
      ])
    )
    const provider = new OpenAICompatibleProvider(baseConfig())
    const chunks: string[] = []
    let promptTokens = 0
    for await (const c of provider.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (c.type === 'delta' && c.text) chunks.push(c.text)
      if (c.type === 'done') promptTokens = c.usage?.promptTokens ?? 0
    }
    expect(chunks.join('')).toBe('剩余价值')
    expect(promptTokens).toBe(11)
  })

  it('发送 Bearer 鉴权头与用户自定义 baseUrl（C-08）', async () => {
    const fetchMock = mockFetch(sseResponse(['data: [DONE]']))
    const provider = new OpenAICompatibleProvider(
      baseConfig({ baseUrl: 'http://127.0.0.1:11434/v1' })
    )
    await collectText(provider, { messages: [{ role: 'user', content: 'hi' }] })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  it('apiKey 为空时不发送 Authorization 头（本地 Ollama 场景 FR-7.6）', async () => {
    const fetchMock = mockFetch(sseResponse(['data: [DONE]']))
    const provider = new OpenAICompatibleProvider(baseConfig({ apiKey: '' }))
    await collectText(provider, { messages: [{ role: 'user', content: 'hi' }] })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('jsonMode 转为 response_format', async () => {
    const fetchMock = mockFetch(sseResponse(['data: [DONE]']))
    const provider = new OpenAICompatibleProvider(baseConfig())
    await collectText(provider, { messages: [{ role: 'user', content: 'hi' }], jsonMode: true })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('图像输入转为 image_url data URL（解题视觉输入 FR-6.3）', async () => {
    const fetchMock = mockFetch(sseResponse(['data: [DONE]']))
    const provider = new OpenAICompatibleProvider(baseConfig())
    await collectText(provider, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '解这道题' },
            { type: 'image', data: 'QUJD', mimeType: 'image/png' }
          ]
        }
      ]
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.messages[0].content[1].image_url.url).toBe('data:image/png;base64,QUJD')
  })
})

describe('Anthropic 原生适配器', () => {
  it('使用 x-api-key 与 /v1/messages 端点', async () => {
    const fetchMock = mockFetch(sseResponse(['data: {"type":"message_stop"}']))
    const provider = new AnthropicProvider(
      baseConfig({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' })
    )
    await collectText(provider, { messages: [{ role: 'user', content: 'hi' }] })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers.Authorization).toBeUndefined()
  })

  it('system 消息提升为顶层字段，不留在 messages 中', async () => {
    const fetchMock = mockFetch(sseResponse(['data: {"type":"message_stop"}']))
    const provider = new AnthropicProvider(baseConfig({ protocol: 'anthropic' }))
    await collectText(provider, {
      messages: [
        { role: 'system', content: '你是术语解释助手' },
        { role: 'user', content: '什么是异化劳动' }
      ]
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.system).toContain('术语解释助手')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    expect(body.max_tokens).toBe(4096)
  })

  it('解析 content_block_delta 并在 message_stop 结束', async () => {
    mockFetch(
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"生产"}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"关系"}}',
        'data: {"type":"message_delta","usage":{"output_tokens":9}}',
        'data: {"type":"message_stop"}'
      ])
    )
    const provider = new AnthropicProvider(baseConfig({ protocol: 'anthropic' }))
    let text = ''
    let completion = 0
    for await (const c of provider.chat({ messages: [{ role: 'user', content: 'x' }] })) {
      if (c.type === 'delta' && c.text) text += c.text
      if (c.type === 'done') completion = c.usage?.completionTokens ?? 0
    }
    expect(text).toBe('生产关系')
    expect(completion).toBe(9)
  })

  it('jsonMode 无原生支持时降级为 system 指令', async () => {
    const fetchMock = mockFetch(sseResponse(['data: {"type":"message_stop"}']))
    const provider = new AnthropicProvider(baseConfig({ protocol: 'anthropic' }))
    await collectText(provider, {
      messages: [{ role: 'user', content: 'hi' }],
      jsonMode: true
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string).system).toContain('JSON')
  })
})

describe('Gemini 原生适配器', () => {
  it('Key 走查询参数，端点含 :streamGenerateContent', async () => {
    const fetchMock = mockFetch(sseResponse(['data: {"candidates":[]}']))
    const provider = new GeminiProvider(
      baseConfig({
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-1.5-flash'
      })
    )
    await collectText(provider, { messages: [{ role: 'user', content: 'hi' }] })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('models/gemini-1.5-flash:streamGenerateContent')
    expect(url).toContain('alt=sse')
    expect(url).toContain('key=sk-test')
    expect((init.headers as Record<string, string>)['x-api-key']).toBeUndefined()
  })

  it('assistant 角色映射为 model，system 走 systemInstruction', async () => {
    const fetchMock = mockFetch(sseResponse(['data: {"candidates":[]}']))
    const provider = new GeminiProvider(baseConfig({ protocol: 'gemini' }))
    await collectText(provider, {
      messages: [
        { role: 'system', content: '简洁作答' },
        { role: 'user', content: '什么是上层建筑' },
        { role: 'assistant', content: '指...' }
      ]
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.systemInstruction.parts[0].text).toBe('简洁作答')
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model'])
  })

  it('解析 candidates parts 与 usageMetadata', async () => {
    mockFetch(
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"辩证"}]}}]}',
        'data: {"candidates":[{"content":{"parts":[{"text":"唯物主义"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":6}}'
      ])
    )
    const provider = new GeminiProvider(baseConfig({ protocol: 'gemini' }))
    let text = ''
    let usage = { promptTokens: 0, completionTokens: 0 }
    for await (const c of provider.chat({ messages: [{ role: 'user', content: 'x' }] })) {
      if (c.type === 'delta' && c.text) text += c.text
      if (c.type === 'done' && c.usage) usage = c.usage
    }
    expect(text).toBe('辩证唯物主义')
    expect(usage).toEqual({ promptTokens: 5, completionTokens: 6 })
  })

  it('图像输入转为 inlineData', async () => {
    const fetchMock = mockFetch(sseResponse(['data: {"candidates":[]}']))
    const provider = new GeminiProvider(baseConfig({ protocol: 'gemini' }))
    await collectText(provider, {
      messages: [
        { role: 'user', content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }] }
      ]
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'image/png', data: 'QUJD' })
  })
})

describe('错误处理与重试', () => {
  it('HTTP 401 不重试并返回 error 分片', async () => {
    const fetchMock = vi.fn(async () => new Response('bad key', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAICompatibleProvider(baseConfig({ maxRetries: 3 }))
    const chunks = []
    for await (const c of provider.chat({ messages: [{ role: 'user', content: 'x' }] })) {
      chunks.push(c)
    }
    expect(chunks[0].type).toBe('error')
    expect(chunks[0].error).toContain('401')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('HTTP 500 按 maxRetries 重试', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAICompatibleProvider(baseConfig({ maxRetries: 2 }))
    for await (const c of provider.chat({ messages: [{ role: 'user', content: 'x' }] })) {
      void c
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('test() 返回 ok:false 而非抛错（FR-7.4）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 }))
    )
    const result = await new OpenAICompatibleProvider(baseConfig()).test()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('403')
  })

  it('test() 成功时返回延迟与模型名', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ model: 'gpt-4o-mini' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    )
    const result = await new OpenAICompatibleProvider(baseConfig()).test()
    expect(result.ok).toBe(true)
    expect(result.model).toBe('gpt-4o-mini')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })
})

describe('SSE 解析与 JSON 提取', () => {
  it('兼容 CRLF 分隔与 event 字段', async () => {
    const res = new Response('event: ping\r\ndata: {"a":1}\r\n\r\ndata: {"a":2}\n\n')
    const out: Array<{ event?: string; data: string }> = []
    for await (const item of parseSse(res)) out.push(item)
    expect(out).toEqual([
      { event: 'ping', data: '{"a":1}' },
      { event: undefined, data: '{"a":2}' }
    ])
  })

  it('extractJson 剥离 Markdown 代码围栏', () => {
    expect(extractJson('```json\n{"terms":["剩余价值"]}\n```')).toEqual({ terms: ['剩余价值'] })
  })

  it('extractJson 容忍前后缀噪声', () => {
    expect(extractJson('好的，结果如下：[{"t":"异化劳动"}] 完毕')).toEqual([{ t: '异化劳动' }])
  })

  it('extractJson 对完全非 JSON 抛错', () => {
    expect(() => extractJson('抱歉我不知道')).toThrow()
  })
})
