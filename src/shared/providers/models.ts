import { z } from 'zod'
import { providerModelsRequestSchema } from '../config/schema'
import type { ProviderModelsRequest, ProviderModelsResult, ProviderProtocol } from '../types/provider'
import { joinUrl, ProviderError, requestWithRetry } from './http'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 2000
const MAX_PAGES = 5
const TIMEOUT_MS = 20000
const FORMAT_ERROR = '服务返回的模型列表格式不正确，请检查接口地址，或手动填写模型名称。'
const LIMIT_ERROR = '模型列表超过允许的大小或页数，请手动填写模型名称。'
const modelIdSchema = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/)
const cursorSchema = z.string().min(1).max(2000)
const modelSchema = z.object({
  id: modelIdSchema,
  name: z.string().trim().min(1).max(200).optional()
})
const dataPageSchema = z.object({
  data: z.array(z.unknown()),
  has_more: z.boolean().optional(),
  last_id: cursorSchema.nullish()
})
const geminiPageSchema = z.object({
  models: z.array(z.unknown()),
  nextPageToken: z.string().max(2000).optional()
})
const rawModelSchema = z.object({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  display_name: z.unknown().optional(),
  displayName: z.unknown().optional(),
  supportedGenerationMethods: z.array(z.string()).optional()
})

class ModelListError extends Error {}

/** 只给根地址补协议默认路径，保留用户配置的代理前缀与版本。 */
export function normalizeProviderBaseUrl(baseUrl: string, protocol: ProviderProtocol): string {
  const url = new URL(baseUrl.trim())
  if (url.pathname === '/') {
    if (protocol === 'openai') url.pathname = '/v1'
    if (protocol === 'gemini') url.pathname = '/v1beta'
  }
  return url.toString().replace(/\/+$/, '')
}

/** 按实际读取字节限制整个发现操作；不接受服务返回的下一页 URL。 */
export async function listProviderModels(input: ProviderModelsRequest): Promise<ProviderModelsResult> {
  const parsed = providerModelsRequestSchema.safeParse(input)
  if (!parsed.success) throw new ModelListError('请填写有效的协议、接口地址和密钥；地址须使用 HTTPS，本机可使用 HTTP。')
  const { protocol, apiKey } = parsed.data
  const baseUrl = normalizeProviderBaseUrl(parsed.data.baseUrl, protocol)
  const endpoint = joinUrl(baseUrl, protocol === 'anthropic' ? 'v1/models' : 'models')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) {
    if (protocol === 'openai') headers.Authorization = `Bearer ${apiKey}`
    else headers[protocol === 'anthropic' ? 'x-api-key' : 'x-goog-api-key'] = apiKey
  }
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const models = new Map<string, ProviderModelsResult['models'][number]>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let bytes = 0
  let entries = 0

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(endpoint)
      if (protocol === 'anthropic') url.searchParams.set('limit', '1000')
      if (protocol === 'gemini') url.searchParams.set('pageSize', '1000')
      if (cursor) url.searchParams.set(protocol === 'gemini' ? 'pageToken' : protocol === 'anthropic' ? 'after_id' : 'after', cursor)
      const response = await requestWithRetry({
        url: url.toString(), method: 'GET', headers, timeoutMs: TIMEOUT_MS,
        maxRetries: 0, signal: controller.signal
      })
      const json = await readJson(response, MAX_BYTES - bytes)
      bytes += json.bytes
      let items: unknown[]
      if (protocol === 'gemini') {
        const parsedPage = geminiPageSchema.safeParse(json.value)
        if (!parsedPage.success) throw new ModelListError(FORMAT_ERROR)
        items = parsedPage.data.models
        cursor = parsedPage.data.nextPageToken || undefined
      } else {
        const parsedPage = dataPageSchema.safeParse(json.value)
        if (!parsedPage.success) throw new ModelListError(FORMAT_ERROR)
        items = parsedPage.data.data
        cursor = parsedPage.data.has_more ? parsedPage.data.last_id ?? undefined : undefined
        if (parsedPage.data.has_more && !cursor) throw new ModelListError(FORMAT_ERROR)
      }
      entries += items.length
      if (entries > MAX_ENTRIES) throw new ModelListError(LIMIT_ERROR)
      for (const item of items) {
        const raw = rawModelSchema.safeParse(item)
        if (!raw.success) throw new ModelListError(FORMAT_ERROR)
        const id = protocol === 'gemini' && typeof raw.data.name === 'string'
          ? raw.data.name.replace(/^models\//, '') : raw.data.id
        const name = protocol === 'gemini' ? raw.data.displayName : protocol === 'anthropic' ? raw.data.display_name : raw.data.name
        const model = modelSchema.safeParse({ id, name })
        if (!model.success) throw new ModelListError(FORMAT_ERROR)
        if (protocol === 'gemini' && raw.data.supportedGenerationMethods && !raw.data.supportedGenerationMethods.includes('generateContent')) continue
        // 上游可能在字段中回显请求凭据；不能将其送回渲染进程。
        if (apiKey && (model.data.id.includes(apiKey) || model.data.name?.includes(apiKey))) throw new ModelListError(FORMAT_ERROR)
        models.set(model.data.id, model.data)
      }
      if (!cursor) return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), baseUrl }
      if (!items.length || cursors.has(cursor)) throw new ModelListError('模型列表的分页信息无效，请手动填写模型名称。')
      cursors.add(cursor)
    }
    throw new ModelListError(LIMIT_ERROR)
  } catch (error) {
    if (error instanceof ModelListError) throw error
    if (controller.signal.aborted) throw new ModelListError('获取模型列表超时，请检查网络后重试，或手动填写模型名称。')
    if (error instanceof ProviderError) {
      if (error.status === 401 || error.status === 403) throw new ModelListError('无法获取模型列表，请检查密钥和模型列表访问权限。')
      if (error.status === 404 || error.status === 405) throw new ModelListError('此地址不支持获取模型列表，请检查接口地址，或手动填写模型名称。')
      if (error.status === 429) throw new ModelListError('获取模型列表过于频繁或额度不足，请稍后重试。')
      if (error.status && error.status >= 500) throw new ModelListError('模型服务暂时不可用，请稍后重试。')
    }
    throw new ModelListError('获取模型列表失败，请检查网络、接口地址和密钥，或手动填写模型名称。')
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function readJson(response: Response, remainingBytes: number): Promise<{ value: unknown; bytes: number }> {
  const reader = response.body?.getReader()
  if (!reader) throw new ModelListError(FORMAT_ERROR)
  let bytes = 0
  let text = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > remainingBytes) throw new ModelListError(LIMIT_ERROR)
      try { text += decoder.decode(chunk.value, { stream: true }) } catch { throw new ModelListError(FORMAT_ERROR) }
    }
    try { return { value: JSON.parse(text + decoder.decode()), bytes } } catch { throw new ModelListError(FORMAT_ERROR) }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
