import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { fetchPublicBytes } from '../../src/main/sources/public-http'

interface FakePage { status?: number; headers?: Record<string, string>; body?: string; hang?: boolean }
function fakeHttp(pages: FakePage[]): Array<{ url: URL; options: http.RequestOptions }> {
  const calls: Array<{ url: URL; options: http.RequestOptions }> = []
  vi.spyOn(http, 'get').mockImplementation(((url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    const page = pages[calls.length] ?? {}
    calls.push({ url, options })
    const request = new EventEmitter() as http.ClientRequest
    request.destroy = ((error?: Error) => {
      if (error) queueMicrotask(() => request.emit('error', error))
      queueMicrotask(() => request.emit('close'))
      return request
    }) as http.ClientRequest['destroy']
    if (!page.hang) queueMicrotask(() => {
      const response = Readable.from([Buffer.from(page.body ?? '')]) as http.IncomingMessage
      response.statusCode = page.status ?? 200
      response.headers = { 'content-type': 'text/plain', ...page.headers }
      response.on('close', () => request.emit('close'))
      callback(response)
    })
    return request
  }) as typeof http.get)
  return calls
}
const dns = () => vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
afterEach(() => vi.restoreAllMocks())

describe('public HTTP transport with synthetic responses', () => {
  it('pins the validated DNS address to a new socket without cookies or authorization', async () => {
    const calls = fakeHttp([{ body: '正文' }])
    const result = await fetchPublicBytes('http://example.com/page', new AbortController().signal, { resolve: dns() })
    expect(new TextDecoder().decode(result.bytes)).toBe('正文')
    expect(calls[0].options.agent).toBe(false)
    expect(calls[0].options.family).toBe(4)
    const callback = vi.fn()
    calls[0].options.lookup!('example.com', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4)
    expect(calls[0].options.headers).not.toHaveProperty('Authorization')
    expect(calls[0].options.headers).not.toHaveProperty('Cookie')
  })
  it.each([4, 6])('uses a single checked DNS address with real Node HTTP lookup semantics for IPv%s', async (family) => {
    const originalGet = http.get
    let requestedAll: boolean | undefined
    let requestedFamily: number | string | undefined
    // Exercise Node's actual connection setup but stop in lookup, before any socket connects.
    vi.spyOn(http, 'get').mockImplementation(((url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) =>
      originalGet(url, { ...options, lookup: (_hostname, lookupOptions, done) => {
        requestedAll = lookupOptions.all
        requestedFamily = lookupOptions.family
        done(new Error('synthetic lookup stop'), '', family)
      } }, callback)) as typeof http.get)
    const resolveDns = vi.fn().mockResolvedValue([{ address: family === 4 ? '8.8.8.8' : '2606:4700:4700::1111', family }])
    await expect(fetchPublicBytes('http://example.com/', new AbortController().signal, { resolve: resolveDns })).rejects.toThrow('连接失败')
    expect(requestedAll).not.toBe(true)
    expect(requestedFamily).toBe(family)
  })
  it('rejects redirects to internal addresses before making another request', async () => {
    const calls = fakeHttp([{ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }])
    await expect(fetchPublicBytes('http://example.com/page', new AbortController().signal, { resolve: dns() })).rejects.toThrow('内网')
    expect(calls).toHaveLength(1)
  })
  it('rechecks DNS after a redirect, including same-host DNS rebinding', async () => {
    const resolveDns = dns().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
    const calls = fakeHttp([{ status: 302, headers: { location: '/second' } }])
    await expect(fetchPublicBytes('http://example.com/page', new AbortController().signal, { resolve: resolveDns })).rejects.toThrow('内网')
    expect(calls).toHaveLength(1)
    expect(resolveDns).toHaveBeenCalledTimes(2)
  })
  it('rejects credential-bearing redirects and limits redirect loops', async () => {
    fakeHttp([{ status: 302, headers: { location: 'http://user:secret@example.net/' } }])
    await expect(fetchPublicBytes('http://example.com', new AbortController().signal, { resolve: dns() })).rejects.toThrow('账号密码')
    vi.restoreAllMocks()
    const calls = fakeHttp(Array.from({ length: 6 }, () => ({ status: 302, headers: { location: '/again' } })))
    await expect(fetchPublicBytes('http://example.com', new AbortController().signal, { resolve: dns() })).rejects.toThrow('跳转次数')
    expect(calls).toHaveLength(6)
  })
  it('limits body bytes even without Content-Length and refuses compressed content', async () => {
    fakeHttp([{ body: 'too much' }])
    await expect(fetchPublicBytes('http://example.com', new AbortController().signal, { resolve: dns(), maxBytes: 3 })).rejects.toThrow('上限')
    vi.restoreAllMocks()
    fakeHttp([{ headers: { 'content-encoding': 'gzip' } }])
    await expect(fetchPublicBytes('http://example.com', new AbortController().signal, { resolve: dns() })).rejects.toThrow('内容编码')
  })
  it('fails safely on HTTP errors and connection timeouts without exposing URL query tokens', async () => {
    fakeHttp([{ status: 403 }])
    await expect(fetchPublicBytes('http://example.com?token=very-secret', new AbortController().signal, { resolve: dns() })).rejects.toThrow('HTTP 403')
    vi.restoreAllMocks()
    fakeHttp([{ hang: true }])
    await expect(fetchPublicBytes('http://example.com?token=very-secret', new AbortController().signal, { resolve: dns(), timeoutMs: 5 })).rejects.toThrow('读取超时')
  })
})
