import { afterEach, describe, expect, it, vi } from 'vitest'
import { providerModelsRequestSchema } from '../../src/shared/config/schema'
import { listProviderModels, normalizeProviderBaseUrl } from '../../src/shared/providers/models'
import type { ProviderModelsRequest } from '../../src/shared/types/provider'

const draft: ProviderModelsRequest = { protocol: 'openai', baseUrl: 'https://example.test', apiKey: 'test-draft-key' }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
function mockPages(...pages: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>()
  for (const page of pages) fetch.mockResolvedValueOnce(json(page))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('model-list addresses and authentication', () => {
  it.each([
    ['openai', 'https://EXAMPLE.test/', 'https://example.test/v1'],
    ['openai', 'https://example.test/v1/', 'https://example.test/v1'],
    ['openai', 'http://127.0.0.1:1234', 'http://127.0.0.1:1234/v1'],
    ['openai', 'https://example.test/proxy/api', 'https://example.test/proxy/api'],
    ['anthropic', 'https://example.test/', 'https://example.test'],
    ['anthropic', 'https://example.test/proxy', 'https://example.test/proxy'],
    ['gemini', 'https://example.test/', 'https://example.test/v1beta'],
    ['gemini', 'https://example.test/v1', 'https://example.test/v1'],
    ['gemini', 'https://example.test/proxy/v1beta/', 'https://example.test/proxy/v1beta']
  ] as const)('normalizes %s address %s', (protocol, address, expected) => {
    expect(normalizeProviderBaseUrl(address, protocol)).toBe(expected)
  })

  it('fetches an unsaved draft without name/model and returns a normalized chat base', async () => {
    const fetch = mockPages({ data: [{ id: 'z-model' }, { id: 'a-model', name: 'A model' }, { id: 'z-model' }] })
    const result = await listProviderModels({ ...draft, baseUrl: ' https://example.test/ ' })
    expect(result).toEqual({ baseUrl: 'https://example.test/v1', models: [{ id: 'a-model', name: 'A model' }, { id: 'z-model' }] })
    expect(fetch).toHaveBeenCalledWith('https://example.test/v1/models', expect.objectContaining({
      method: 'GET', redirect: 'error', body: undefined,
      headers: { Accept: 'application/json', Authorization: 'Bearer test-draft-key' }
    }))
  })

  it('uses the Anthropic prefix and version header', async () => {
    const fetch = mockPages({ data: [{ id: 'claude-test', display_name: 'Claude test' }], has_more: false })
    expect((await listProviderModels({ ...draft, protocol: 'anthropic', baseUrl: 'https://example.test/proxy' })).models).toEqual([{ id: 'claude-test', name: 'Claude test' }])
    expect(fetch).toHaveBeenCalledWith('https://example.test/proxy/v1/models?limit=1000', expect.objectContaining({
      headers: { Accept: 'application/json', 'x-api-key': draft.apiKey, 'anthropic-version': '2023-06-01' }
    }))
  })

  it('uses Gemini header authentication and keeps only models supporting text generation', async () => {
    const fetch = mockPages({ models: [
      { name: 'models/gemini-test', displayName: 'Gemini test', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/compatible-model' }
    ] })
    const result = await listProviderModels({ ...draft, protocol: 'gemini' })
    expect(result.models).toEqual([{ id: 'compatible-model' }, { id: 'gemini-test', name: 'Gemini test' }])
    expect(fetch).toHaveBeenCalledWith('https://example.test/v1beta/models?pageSize=1000', expect.objectContaining({
      headers: { Accept: 'application/json', 'x-goog-api-key': draft.apiKey }
    }))
    expect(String(fetch.mock.calls[0][0])).not.toContain(draft.apiKey)
  })

  it.each(['openai', 'anthropic', 'gemini'] as const)('allows anonymous local %s without auth headers', async (protocol) => {
    const fetch = mockPages(protocol === 'gemini' ? { models: [] } : { data: [] })
    await listProviderModels({ protocol, baseUrl: 'http://127.0.0.1:1234', apiKey: '' })
    const headers = fetch.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['x-goog-api-key']).toBeUndefined()
  })

  it.each(['http://external.test', 'file:///secret', 'https://user:password@example.test', 'https://example.test?key=secret', 'https://example.test#secret'])('rejects unsafe URL %s before network', async (baseUrl) => {
    const fetch = mockPages()
    await expect(listProviderModels({ ...draft, baseUrl })).rejects.toThrow('有效')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds IPC input and rejects unrelated configuration fields', () => {
    expect(providerModelsRequestSchema.safeParse(draft).success).toBe(true)
    for (const extra of [{ apiKey: 'x'.repeat(8193) }, { id: 'x'.repeat(101) }, { model: 'unused' }, { protocol: 'unknown' }]) {
      expect(providerModelsRequestSchema.safeParse({ ...draft, ...extra }).success).toBe(false)
    }
  })
})

describe('model-list pagination and limits', () => {
  it.each(['openai', 'anthropic'] as const)('follows %s cursors only on its configured endpoint', async (protocol) => {
    const cursor = 'last&other=secret/https://evil.test'
    const fetch = mockPages(
      { data: [{ id: 'first' }], has_more: true, last_id: cursor, next: 'https://evil.test/models' },
      { data: [{ id: 'last' }], has_more: false }
    )
    expect((await listProviderModels({ ...draft, protocol })).models).toHaveLength(2)
    const next = new URL(String(fetch.mock.calls[1][0]))
    expect(next.origin).toBe('https://example.test')
    expect(next.pathname).toBe('/v1/models')
    expect(next.searchParams.get(protocol === 'openai' ? 'after' : 'after_id')).toBe(cursor)
    expect(next.searchParams.has('other')).toBe(false)
  })

  it('follows Gemini page tokens and deduplicates across pages', async () => {
    const fetch = mockPages(
      { models: [{ name: 'models/first' }], nextPageToken: 'page&token=two' },
      { models: [{ name: 'models/first' }, { name: 'models/last' }] }
    )
    expect((await listProviderModels({ ...draft, protocol: 'gemini' })).models).toHaveLength(2)
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('pageToken')).toBe('page&token=two')
  })

  it('rejects repeated or missing cursors and empty pages claiming more results', async () => {
    let fetch = mockPages(
      { data: [{ id: 'same' }], has_more: true, last_id: 'same' },
      { data: [{ id: 'same' }], has_more: true, last_id: 'same' }
    )
    await expect(listProviderModels(draft)).rejects.toThrow('分页')
    expect(fetch).toHaveBeenCalledTimes(2)
    fetch = mockPages({ data: [{ id: 'first' }], has_more: true })
    await expect(listProviderModels(draft)).rejects.toThrow('格式')
    expect(fetch).toHaveBeenCalledTimes(1)
    mockPages({ models: [], nextPageToken: 'more' })
    await expect(listProviderModels({ ...draft, protocol: 'gemini' })).rejects.toThrow('分页')
  })

  it('fails rather than silently truncating at five pages', async () => {
    const fetch = mockPages(...Array.from({ length: 6 }, (_, index) => ({ data: [{ id: `model-${index}` }], has_more: true, last_id: `cursor-${index}` })))
    await expect(listProviderModels(draft)).rejects.toThrow('大小或页数')
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it('counts all raw entries, including duplicates, against the total limit', async () => {
    const fetch = mockPages(
      { data: Array.from({ length: 1001 }, () => ({ id: 'same' })), has_more: true, last_id: 'next' },
      { data: Array.from({ length: 1000 }, () => ({ id: 'same' })) }
    )
    await expect(listProviderModels(draft)).rejects.toThrow('大小或页数')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('limits bytes across pages, including ignored envelope fields', async () => {
    mockPages(
      { data: [{ id: 'first' }], padding: 'x'.repeat(1100000), has_more: true, last_id: 'next' },
      { data: [{ id: 'last' }], padding: 'x'.repeat(1100000) }
    )
    await expect(listProviderModels(draft)).rejects.toThrow('大小或页数')
  })

  it('cancels a response exceeding the byte limit', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) }, cancel
    }))))
    await expect(listProviderModels(draft)).rejects.toThrow('大小或页数')
    expect(cancel).toHaveBeenCalled()
  })

  it('bounds the entire operation, including a stalled later page body', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15000))
        return json({ data: [{ id: 'first' }], has_more: true, last_id: 'next' })
      })
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
    vi.stubGlobal('fetch', fetch)
    const result = expect(listProviderModels(draft)).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(20001)
    await result
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalled()
  })
})

describe('model-list response errors', () => {
  it.each([{}, null, [], { data: 'models' }, { data: [null] }, { data: [{ id: '' }] }, { data: [{ id: 'x'.repeat(201) }] }, { data: [], has_more: 'yes' }])('rejects malformed response %#', async (body) => {
    mockPages(body)
    await expect(listProviderModels(draft)).rejects.toThrow('格式')
  })

  it('rejects invalid JSON and invalid UTF-8 without reflecting their contents', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(`secret ${draft.apiKey}`))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff])))
    vi.stubGlobal('fetch', fetch)
    await expect(listProviderModels(draft)).rejects.toThrow('格式')
    await expect(listProviderModels(draft)).rejects.toThrow('格式')
  })

  it.each([[401, '密钥'], [403, '权限'], [404, '不支持'], [405, '不支持'], [429, '频繁'], [503, '暂时不可用']] as const)('reports HTTP %s without reflecting remote secrets', async (status, message) => {
    const fetch = vi.fn(async () => new Response(`remote echo ${draft.apiKey}`, { status, statusText: draft.apiKey }))
    vi.stubGlobal('fetch', fetch)
    let failure: unknown
    try { await listProviderModels(draft) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(message)
    expect((failure as Error).message).not.toContain(draft.apiKey)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not expose a draft key echoed in network exceptions or model names', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`network ${draft.apiKey}`)))
    await expect(listProviderModels(draft)).rejects.toThrow('获取模型列表失败')
    mockPages({ data: [{ id: 'model', name: `echo ${draft.apiKey}` }] })
    await expect(listProviderModels(draft)).rejects.toThrow('格式')
  })

  it('does not cache results or drafts between requests', async () => {
    const fetch = mockPages({ data: [{ id: 'first' }] }, { data: [{ id: 'second' }] })
    expect((await listProviderModels(draft)).models[0].id).toBe('first')
    expect((await listProviderModels({ ...draft, apiKey: 'test-new-key' })).models[0].id).toBe('second')
    expect(fetch.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer test-new-key' })
  })
})
