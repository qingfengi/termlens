import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { SOURCE_LIMITS } from '../../shared/types/source'

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 88 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0))
  }
  if (isIP(address) !== 6) return false
  // Accept global-unicast IPv6 only. IPv4-mapped, local and multicast ranges stay rejected.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase()
  const [first, second = '0'] = canonical.split(':')
  return /^[23][0-9a-f]{3}:/.test(canonical) && !canonical.startsWith('2001:db8:') &&
    !(first === '2001' && parseInt(second || '0', 16) <= 0x1ff) &&
    first !== '2002' && first !== '3fff'
}

export function publicUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('网址格式不正确。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅支持不含账号密码的公开 HTTP 或 HTTPS 网页。')
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('网页仅支持标准 HTTP/HTTPS 端口。')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      (isIP(host) && !isPublicAddress(host))) throw new Error('不能读取本机、内网或保留地址。')
  url.hash = ''
  return url
}

export function redactedLocation(url: URL): string {
  return `${url.origin}${url.pathname}`
}

interface PublicResponse { bytes: Uint8Array; contentType: string; url: URL }
interface HttpOptions {
  /** Tests may replace DNS; the returned addresses are still checked. */
  resolve?: typeof lookup
  maxBytes?: number
  timeoutMs?: number
}

export async function fetchPublicBytes(value: string, signal: AbortSignal, options: HttpOptions = {}): Promise<PublicResponse> {
  const deadline = Date.now() + (options.timeoutMs ?? 20000)
  let url = publicUrl(value)
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal.throwIfAborted()
    const timeLeft = deadline - Date.now()
    if (timeLeft <= 0) throw new Error('网页读取超时，请稍后重试。')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    let addresses: { address: string; family: number }[]
    let dnsTimer: ReturnType<typeof setTimeout> | undefined
    try {
      addresses = await Promise.race([
        (options.resolve ?? lookup)(host, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          dnsTimer = setTimeout(() => reject(new Error('网页域名解析超时。')), timeLeft)
          dnsTimer.unref()
        })
      ])
    } catch { throw new Error('网页域名无法解析或读取超时。') }
    finally { clearTimeout(dnsTimer) }
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new Error('不能读取本机、内网或保留地址。')
    }
    signal.throwIfAborted()
    const target = addresses[0]
    const response = await new Promise<PublicResponse | { redirect: string }>((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http
      // Pin the checked DNS answer to this connection; keep the hostname for TLS and Host.
      const request = client.get(url, {
        agent: false,
        family: target.family,
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
        headers: { 'User-Agent': 'TermLens/0.1 (document reader)', Accept: 'text/html,text/plain,application/pdf,application/xhtml+xml', 'Accept-Encoding': 'identity' },
        signal
      }, (incoming) => {
        const status = incoming.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = incoming.headers.location
          incoming.destroy()
          if (!location) reject(new Error('网页跳转缺少目标地址。'))
          else resolve({ redirect: location })
          return
        }
        if (status < 200 || status >= 300) {
          incoming.destroy()
          reject(new Error(`网页返回 HTTP ${status}，无法读取正文。`))
          return
        }
        if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') {
          incoming.destroy()
          reject(new Error('网页未返回可直接读取的内容编码。'))
          return
        }
        const limit = Math.min(options.maxBytes ?? SOURCE_LIMITS.fileBytes, SOURCE_LIMITS.fileBytes)
        if (Number(incoming.headers['content-length'] ?? 0) > limit) {
          incoming.destroy()
          reject(new Error('网页内容超过 25 MiB 读取上限。'))
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        incoming.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > limit) {
            incoming.destroy(new Error('网页内容超过 25 MiB 读取上限。'))
            return
          }
          chunks.push(chunk)
        })
        incoming.on('error', reject)
        incoming.on('end', () => resolve({ bytes: Buffer.concat(chunks), contentType: String(incoming.headers['content-type'] ?? ''), url }))
      })
      const timer = setTimeout(() => request.destroy(new Error('网页读取超时，请稍后重试。')), Math.max(1, deadline - Date.now()))
      request.on('close', () => clearTimeout(timer))
      request.on('error', () => reject(new Error(signal.aborted ? '读取已取消。' : '网页连接失败或读取超时。')))
    })
    if ('redirect' in response) {
      let next: URL
      try { next = new URL(response.redirect, url) } catch { throw new Error('网页跳转地址不正确。') }
      url = publicUrl(next.href)
      continue
    }
    return response
  }
  throw new Error('网页跳转次数过多。')
}
