import { basename, posix } from 'node:path'
import { unzipSync } from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { parseHTML } from 'linkedom'
import { SOURCE_LIMITS, type ExtractedSource, type SourceSegment } from '../../shared/types/source'

interface ExtractionContext { title: string; location: string; format: string; kind?: ExtractedSource['kind'] }
type OrderedNode = Record<string, unknown>

class Segments {
  readonly items: SourceSegment[] = []
  characters = 0
  truncated = false
  add(label: string, text: string, startSeconds?: number): void {
    text = text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
    for (let offset = 0; offset < text.length;) {
      if (this.characters >= SOURCE_LIMITS.characters || this.items.length >= SOURCE_LIMITS.segments) {
        this.truncated = true
        return
      }
      let end = Math.min(text.length, offset + Math.min(SOURCE_LIMITS.segmentCharacters, SOURCE_LIMITS.characters - this.characters))
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
      if (end === offset) { this.truncated = true; return }
      const piece = text.slice(offset, end)
      this.items.push({ id: `s${this.items.length + 1}`, label: offset ? `${label}（续）` : label, text: piece, ...(startSeconds === undefined ? {} : { startSeconds }) })
      this.characters += piece.length
      offset = end
    }
  }
  result(context: ExtractionContext, warnings: string[] = [], coverageNote = ''): ExtractedSource {
    if (this.truncated) warnings.push('内容超过上限，已截取前 50 万字符或前 1000 个片段。')
    if (!this.items.length) warnings.push('没有提取到可读文字；图片、扫描件或受保护内容需要另行提供文字。此功能未执行 OCR。')
    return {
      ...context, kind: context.kind ?? 'file', segments: this.items,
      coverage: warnings.length || coverageNote ? 'partial' : 'complete',
      coverageNote: [coverageNote, ...warnings].filter(Boolean).join(' '), warnings
    }
  }
}

export function decodeText(bytes: Uint8Array, charset = 'utf-8'): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = 'utf-16be'
  try { return new TextDecoder(charset, { fatal: true }).decode(bytes) }
  catch { throw new Error('文字编码无法读取，请转换为 UTF-8 编码后重新导入。') }
}

export function extractHtml(html: string, context: ExtractionContext): ExtractedSource {
  const { document } = parseHTML(html)
  const title = document.querySelector('title')?.textContent?.trim()
  document.querySelectorAll('head,script,style,noscript,template,nav,header,footer,aside,form,button,iframe,svg,canvas,[hidden],[aria-hidden="true"]').forEach((node) => node.remove())
  document.querySelectorAll('[style]').forEach((node) => {
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(node.getAttribute('style') ?? '')) node.remove()
  })
  const body = document.querySelector('body')
  const root = document.querySelector('main') ?? (body?.textContent?.trim() ? body : document)
  const segments = new Segments()
  if (root) {
    // Walk in document order so text outside <p> (common in modern pages) is not lost.
    let pending = '', paragraph = 0
    const flush = (): void => {
      if (pending.trim()) segments.add(`段落 ${++paragraph}`, pending)
      pending = ''
    }
    const walk = (node: Node): void => {
      if (node.nodeType === 3) { pending += node.textContent ?? ''; return }
      if (node.nodeType !== 1 && node.nodeType !== 9) return
      const name = node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : ''
      if (name === 'br') { pending += '\n'; return }
      const block = /^(address|article|blockquote|dd|div|dl|dt|figure|figcaption|h[1-6]|li|main|ol|p|pre|section|table|td|th|tr|ul)$/.test(name)
      if (block) flush()
      Array.from(node.childNodes).forEach(walk)
      if (block) flush()
    }
    walk(root)
    flush()
  }
  return segments.result({ ...context, title: title?.slice(0, 300) || context.title }, [],
    '仅提取收到的 HTML 正文；未运行网页脚本或计算样式，登录后、动态加载、折叠或未返回的内容是否完整无法确定。图片和视频未转为文字。')
}

function subtitleSeconds(value: string): number {
  const parts = value.replace(',', '.').split(':').map(Number)
  if (parts[parts.length - 1] >= 60 || parts[parts.length - 2] >= 60) return NaN
  return parts.reduce((total, part) => total * 60 + part, 0)
}

function extractSubtitles(text: string, context: ExtractionContext): ExtractedSource {
  const segments = new Segments()
  const warnings: string[] = []
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)
  const timing = /^\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$/
  for (const block of blocks) {
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(block.trim())) continue
    const lines = block.split('\n')
    const at = lines.findIndex((line) => timing.test(line))
    if (at < 0) {
      if (block.trim() && !/^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(block.trim())) warnings.push('部分字幕段缺少有效时间，已跳过。')
      continue
    }
    const match = lines[at].match(timing)!
    const start = subtitleSeconds(match[1])
    const end = subtitleSeconds(match[2])
    if (end < start || !Number.isFinite(start) || !Number.isFinite(end)) { warnings.push('部分字幕时间范围不正确，已跳过。'); continue }
    const raw = lines.slice(at + 1).join('\n').replace(/<\d{2}:\d{2}(?::\d{2})?\.\d{3}>/g, '')
    const { document } = parseHTML(`<html><body>${raw}</body></html>`)
    document.querySelectorAll('script,style').forEach((node) => node.remove())
    segments.add(`${match[1]} → ${match[2]}`, document.body.textContent ?? '', start)
  }
  return segments.result(context, [...new Set(warnings)])
}

function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name
  return name
}

function extractDelimited(text: string, context: ExtractionContext): ExtractedSource {
  const delimiter = context.format === 'tsv' ? '\t' : ','
  const segments = new Segments()
  const warnings: string[] = []
  let fields: string[] = [], field = '', quoted = false, row = 1
  const finishRow = (): void => {
    fields.push(field)
    segments.add(`第 ${row} 行`, fields.map((value, index) => `${columnName(index)}${row}：${value}`).join(' | '))
    row++; fields = []; field = ''
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"' && (quoted || field.length === 0)) {
      if (quoted && text[i + 1] === '"') { field += '"'; i++ } else quoted = !quoted
    } else if (char === delimiter && !quoted) { fields.push(field); field = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++
      finishRow()
      if (segments.truncated) break
    } else field += char
  }
  if (field || fields.length) finishRow()
  if (quoted) warnings.push('文件有未闭合的引号，最后一行可能不完整。')
  return segments.result(context, warnings)
}

function readArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  let expanded = 0, entries = 0
  try {
    return unzipSync(bytes, { filter: (entry) => {
      entries++
      expanded += entry.originalSize
      if (entries > 5000 || expanded > 50 * 1024 * 1024 || entry.originalSize > SOURCE_LIMITS.fileBytes) throw new Error('archive-limit')
      return /\.xml$|\.rels$/.test(entry.name) && !entry.name.includes('..')
    } })
  } catch { throw new Error('文档压缩内容损坏、已加密或解压后超过安全上限（50 MiB / 5000 项）。') }
}

function xml(archive: Record<string, Uint8Array>, name: string): OrderedNode[] {
  const bytes = archive[name]
  if (!bytes) throw new Error('文档缺少必要的结构，无法读取。')
  const text = decodeText(bytes)
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new Error('文档 XML 结构损坏或包含不支持的实体定义。')
  return new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false }).parse(text) as OrderedNode[]
}

function children(node: OrderedNode, key: string): OrderedNode[] {
  return Array.isArray(node[key]) ? node[key] as OrderedNode[] : []
}
function findNodes(nodes: OrderedNode[], tag: string): OrderedNode[] {
  const result: OrderedNode[] = []
  for (const node of nodes) {
    if (tag in node) result.push(node)
    else for (const [key, value] of Object.entries(node)) if (key !== ':@' && Array.isArray(value)) result.push(...findNodes(value as OrderedNode[], tag))
  }
  return result
}
function attr(node: OrderedNode, key: string): string {
  return String((node[':@'] as Record<string, unknown> | undefined)?.[`@_${key}`] ?? '')
}
function textOf(nodes: OrderedNode[]): string {
  return nodes.map((node) => Object.entries(node).map(([key, value]) => {
    if (key === '#text') return String(value)
    if (key === 'w:tab') return '\t'
    if (key === 'w:br' || key === 'a:br') return '\n'
    return key !== ':@' && Array.isArray(value) ? textOf(value as OrderedNode[]) : ''
  }).join('')).join('')
}
function selectedText(nodes: OrderedNode[], tag: string): string {
  return nodes.map((node) => Object.entries(node).map(([key, value]) => {
    if (key === 'w:del' || key === ':@') return ''
    if (key === tag) return textOf(children(node, tag))
    if (tag === 'w:t' && key === 'w:tab') return '\t'
    if ((tag === 'w:t' && key === 'w:br') || (tag === 'a:t' && key === 'a:br')) return '\n'
    return Array.isArray(value) ? selectedText(value as OrderedNode[], tag) : ''
  }).join('')).join('')
}

function extractOffice(bytes: Uint8Array, context: ExtractionContext): ExtractedSource {
  const archive = readArchive(bytes)
  const segments = new Segments()
  if (context.format === 'docx') {
    const document = xml(archive, 'word/document.xml')
    findNodes(document, 'w:p').forEach((node, index) => {
      const clean = children(node, 'w:p').filter((child) => !('w:del' in child))
      segments.add(`段落 ${index + 1}`, selectedText(clean, 'w:t'))
    })
    return segments.result(context, [], '已读取文档正文段落和表格文字；未计算 Word 分页，页眉页脚、脚注、批注、图片及文本框可能未包含。')
  }
  if (context.format === 'pptx') {
    let slides: string[]
    if (archive['ppt/presentation.xml'] && archive['ppt/_rels/presentation.xml.rels']) {
      const relationships = findNodes(xml(archive, 'ppt/_rels/presentation.xml.rels'), 'Relationship')
      const targets = new Map(relationships.filter((node) => attr(node, 'TargetMode') !== 'External').map((node) => [attr(node, 'Id'), attr(node, 'Target')]))
      slides = findNodes(xml(archive, 'ppt/presentation.xml'), 'p:sldId').map((node) => {
        const target = targets.get(attr(node, 'r:id'))
        if (!target) throw new Error('幻灯片引用缺失，无法确定播放顺序。')
        const path = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('ppt', target))
        if (!/^ppt\/slides\/[^/]+\.xml$/.test(path)) throw new Error('幻灯片路径不正确。')
        return path
      })
    } else {
      slides = Object.keys(archive).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)![1]) - Number(b.match(/slide(\d+)\.xml$/)![1]))
    }
    if (!slides.length) throw new Error('演示文稿中未找到幻灯片。')
    slides.forEach((name, index) => {
      const paragraphs = findNodes(xml(archive, name), 'a:p').map((node) => selectedText(children(node, 'a:p'), 'a:t')).filter(Boolean)
      segments.add(`幻灯片 ${index + 1}`, paragraphs.join('\n'))
    })
    return segments.result(context, [], '已读取幻灯片文字；图片、图表、备注、动画和嵌入媒体未转换为文字。')
  }
  const workbook = xml(archive, 'xl/workbook.xml')
  const relationships = xml(archive, 'xl/_rels/workbook.xml.rels')
  const relations = new Map(findNodes(relationships, 'Relationship')
    .filter((node) => attr(node, 'TargetMode') !== 'External')
    .map((node) => [attr(node, 'Id'), attr(node, 'Target')]))
  const strings = archive['xl/sharedStrings.xml'] ? findNodes(xml(archive, 'xl/sharedStrings.xml'), 'si').map((node) => selectedText(children(node, 'si'), 't')) : []
  const warnings: string[] = []
  for (const sheet of findNodes(workbook, 'sheet')) {
    const target = relations.get(attr(sheet, 'r:id'))
    if (!target) { warnings.push('部分工作表引用缺失，已跳过。'); continue }
    const file = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target))
    if (!file.startsWith('xl/') || file.includes('..')) throw new Error('工作表路径不正确。')
    const cells = findNodes(xml(archive, file), 'c')
    const name = attr(sheet, 'name') || '工作表'
    for (const cell of cells) {
      const content = children(cell, 'c')
      const value = selectedText(content, 'v')
      const type = attr(cell, 't')
      const text = type === 's' ? strings[Number(value)] ?? '' : type === 'inlineStr' ? selectedText(content, 't') : type === 'b' ? (value === '1' ? 'TRUE' : 'FALSE') : value
      if (findNodes(content, 'f').length && !value) warnings.push('部分公式没有已保存的计算结果，未执行公式计算。')
      segments.add(`${name} · ${attr(cell, 'r') || '未知单元格'}`, text)
      if (segments.truncated) break
    }
    if (segments.truncated) break
  }
  return segments.result(context, [...new Set(warnings)], '已读取工作表单元格的保存值；不执行公式。日期可能显示为原始序列数，格式、图表、图片和批注未提取。')
}

async function extractPdf(bytes: Uint8Array, context: ExtractionContext): Promise<ExtractedSource> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true })
  const segments = new Segments()
  let emptyPages = 0
  try {
    const document = await task.promise
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim()
      if (!text) emptyPages++
      segments.add(`第 ${pageNumber} 页`, text)
      page.cleanup()
      if (segments.truncated) break
    }
    return segments.result(context, emptyPages ? [`有 ${emptyPages} 页未提取到文字，可能是图片或扫描页；未执行 OCR。`] : [],
      '已按页提取 PDF 文字层；多栏、表格或特殊字体的阅读顺序可能不准确，图片和图形未转为文字。')
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('PDF 需要密码，请先导出可读取的未加密副本。')
    throw new Error('PDF 文字层读取失败，文件可能损坏、受保护或不受支持。')
  } finally { await task.destroy() }
}

export async function extractBytes(bytes: Uint8Array, format: string, location: string, options: { kind?: ExtractedSource['kind']; charset?: string; title?: string } = {}): Promise<ExtractedSource> {
  if (bytes.byteLength > SOURCE_LIMITS.fileBytes) throw new Error('文件超过 25 MiB 读取上限。')
  const context = { title: options.title ?? basename(location), location, format, kind: options.kind }
  if (format === 'pdf') return extractPdf(bytes, context)
  if (['docx', 'xlsx', 'pptx'].includes(format)) return extractOffice(bytes, context)
  if (!['txt', 'md', 'csv', 'tsv', 'html', 'htm', 'srt', 'vtt'].includes(format)) throw new Error('暂不支持此文件格式。支持 TXT、Markdown、CSV、TSV、HTML、SRT、VTT、DOCX、XLSX、PPTX 和 PDF。')
  const text = decodeText(bytes, options.charset)
  if (format === 'html' || format === 'htm') return extractHtml(text, context)
  if (format === 'srt' || format === 'vtt') return extractSubtitles(text, context)
  if (format === 'csv' || format === 'tsv') return extractDelimited(text, context)
  const segments = new Segments()
  text.split(/\n\s*\n/).forEach((paragraph, index) => segments.add(`段落 ${index + 1}`, paragraph))
  return segments.result(context)
}
