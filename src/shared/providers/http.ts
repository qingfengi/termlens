/**
 * Provider 公共工具：超时、重试、SSE 解析。
 * 不依赖 Electron，供手机端复用（NFR-9）。
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** 是否值得重试：网络错误与 429 / 5xx */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

export interface FetchOptions {
  url: string
  method?: string
  headers: Record<string, string>
  body?: unknown
  timeoutMs: number
  maxRetries: number
  signal?: AbortSignal
}

export async function requestWithRetry(opts: FetchOptions): Promise<Response> {
  const { url, method = 'POST', headers, body, timeoutMs, maxRetries, signal } = opts
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new ProviderError('请求已取消')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let bodyOwnsTimeout = false

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error'
      })

      if (!res.ok) {
        await res.body?.cancel()
        const retryable = isRetryableStatus(res.status)
        const err = new ProviderError(
          `HTTP ${res.status} ${res.statusText}`,
          res.status,
          retryable
        )
        if (retryable && attempt < maxRetries) {
          lastError = err
          await sleep(backoffMs(attempt), signal)
          continue
        }
        throw err
      }

      if (!res.body) return res
      const reader = res.body.getReader()
      let finished = false
      let abortBody: () => void = () => {}
      const finish = (): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        controller.signal.removeEventListener('abort', abortBody)
      }
      bodyOwnsTimeout = true
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          abortBody = () => {
            if (finished) return
            finish()
            streamController.error(new ProviderError('请求已超时或取消'))
            void reader.cancel().catch(() => {})
          }
          controller.signal.addEventListener('abort', abortBody, { once: true })
          if (controller.signal.aborted) abortBody()
        },
        async pull(streamController) {
          try {
            const part = await reader.read()
            if (finished) return
            if (part.done) { finish(); streamController.close() }
            else streamController.enqueue(part.value)
          } catch (error) { if (!finished) { finish(); streamController.error(error) } }
        },
        async cancel() { finish(); await reader.cancel() }
      })
      return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers })
    } catch (err) {
      lastError = err
      const aborted = signal?.aborted === true
      if (aborted) throw new ProviderError('请求已取消', undefined, false)
      const isLast = attempt >= maxRetries
      if (err instanceof ProviderError && !err.retryable) throw err
      if (isLast) break
      await sleep(backoffMs(attempt), signal)
    } finally {
      if (!bodyOwnsTimeout) { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new ProviderError(`请求失败（已重试 ${maxRetries} 次）：${detail}`,
    lastError instanceof ProviderError ? lastError.status : undefined,
    lastError instanceof ProviderError ? lastError.retryable : false)
}

function backoffMs(attempt: number): number {
  // 指数退避 + 抖动，避免多个术语并发请求同时重试打爆端点
  return Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ProviderError('请求已取消')); return }
    const abort = (): void => { clearTimeout(timer); reject(new ProviderError('请求已取消')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

/**
 * 解析 SSE 流，逐条 yield `data:` 负载。
 * 兼容 OpenAI / Anthropic 的 SSE 格式差异（事件名由调用方按需处理）。
 */
export async function* parseSse(
  res: Response
): AsyncGenerator<{ event?: string; data: string }, void, unknown> {
  const body = res.body
  if (!body) throw new ProviderError('响应无 body，无法读取流')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.length
      if (totalBytes > 2 * 1024 * 1024) throw new ProviderError('响应超过允许大小')
      buffer += decoder.decode(value, { stream: true })

      let sep: number
      // SSE 以空行分隔事件块，兼容 \n\n 与 \r\n\r\n
      while ((sep = findBlockEnd(buffer)) !== -1) {
        const rawBlock = buffer.slice(0, sep)
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, '')

        let event: string | undefined
        const dataLines: string[] = []
        for (const line of rawBlock.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length > 0) {
          yield { event, data: dataLines.join('\n') }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function findBlockEnd(buffer: string): number {
  const a = buffer.indexOf('\n\n')
  const b = buffer.indexOf('\r\n\r\n')
  if (a === -1) return b
  if (b === -1) return a
  return Math.min(a, b)
}

/** 从可能带 ```json 包裹的模型输出中提取 JSON */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    // 退一步：截取第一个 { 或 [ 到最后一个 } 或 ]
    const start = candidate.search(/[[{]/)
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'))
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1))
    }
    throw new ProviderError('模型未返回合法 JSON')
  }
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.replace(/^\/+/, '')
  return `${base}/${suffix}`
}
