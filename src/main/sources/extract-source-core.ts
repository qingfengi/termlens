import { open } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { SOURCE_LIMITS, type ExtractedSource, type SourceRequest } from '../../shared/types/source'
import { extractBytes } from './extract-parsers'
import { fetchPublicBytes, publicUrl, redactedLocation } from './public-http'

function rejectVideoUrl(url: URL): void {
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') ||
      host === 'b23.tv' || ((host === 'bilibili.com' || host.endsWith('.bilibili.com')) && /\/(video|bangumi|cheese)\//.test(url.pathname))) {
    throw new Error('此版本尚不能可靠取得该视频的完整字幕。请导入课程的 SRT、VTT 或文字稿；网页标题和简介不会当作课程全文。')
  }
}

export async function extractSourceCore(request: SourceRequest, signal: AbortSignal, onProgress: (message: string) => void): Promise<ExtractedSource> {
  signal.throwIfAborted()
  if (!request.location || typeof request.location !== 'string') throw new Error('没有指定要读取的文件或网页。')
  if (request.kind === 'file') {
    if (!isAbsolute(request.location)) throw new Error('请选择绝对路径的本地文件。')
    if (/^(?:\\\\|\/\/)/.test(request.location)) throw new Error('暂不读取网络共享或设备路径，请先保存为本地文件。')
    const format = extname(request.location).slice(1).toLowerCase()
    if (!['txt', 'md', 'csv', 'tsv', 'html', 'htm', 'srt', 'vtt', 'docx', 'xlsx', 'pptx', 'pdf'].includes(format)) throw new Error('暂不支持此文件格式。')
    onProgress('正在读取本地文件…')
    const handle = await open(request.location, 'r').catch(() => { throw new Error('文件无法打开，可能已移动或没有读取权限。') })
    let bytes: Uint8Array
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('请选择普通文件。')
      if (info.size > SOURCE_LIMITS.fileBytes) throw new Error('文件超过 25 MiB 读取上限。')
      // A bounded read also handles a selected file that grows after the stat call.
      const buffer = Buffer.alloc(Math.min(info.size + 1, SOURCE_LIMITS.fileBytes + 1))
      let offset = 0
      while (offset < buffer.length) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset > info.size) throw new Error('读取期间文件发生变化，请保存文件后重试。')
      bytes = buffer.subarray(0, offset)
    } finally { await handle.close() }
    signal.throwIfAborted()
    onProgress(`正在提取 ${format.toUpperCase()} 文字…`)
    return extractBytes(bytes, format, request.location)
  }
  if (request.kind !== 'url') throw new Error('当前窗口文字由窗口读取服务处理。')
  const url = publicUrl(request.location)
  rejectVideoUrl(url)
  onProgress('正在安全连接公开网页…')
  const response = await fetchPublicBytes(url.href, signal)
  rejectVideoUrl(response.url)
  const mime = response.contentType.split(';')[0].trim().toLowerCase()
  const pathFormat = extname(response.url.pathname).slice(1).toLowerCase()
  const format = mime === 'application/pdf' ? 'pdf' : mime === 'text/vtt' ? 'vtt' : mime === 'text/plain' ?
    (['srt', 'vtt', 'md', 'csv', 'tsv'].includes(pathFormat) ? pathFormat : 'txt') :
    ['text/html', 'application/xhtml+xml'].includes(mime) ? 'html' : ''
  if (!format) throw new Error('此网址没有返回支持的 HTML、纯文字、字幕或 PDF 内容，请下载文件后导入。')
  const charset = response.contentType.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]
  onProgress('正在提取网页正文…')
  return extractBytes(response.bytes, format, redactedLocation(response.url), {
    kind: format === 'srt' || format === 'vtt' ? 'video' : 'web', charset,
    title: basename(response.url.pathname) || response.url.hostname
  })
}
