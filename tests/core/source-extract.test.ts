import { afterAll, describe, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { extractBytes, extractHtml } from '../../src/main/sources/extract-parsers'
import { extractSourceCore } from '../../src/main/sources/extract-source-core'
import { fetchPublicBytes, isPublicAddress, publicUrl, redactedLocation } from '../../src/main/sources/public-http'
import { SOURCE_LIMITS } from '../../src/shared/types/source'

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const office = (files: Record<string, string>): Uint8Array => zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])))
const scratch = resolve('qa/source-extract-tests')
const fixturePath = resolve(scratch, 'fixture.txt')
afterAll(async () => { await unlink(fixturePath).catch(() => undefined) })

describe('source text and subtitle extraction', () => {
  it('preserves paragraphs and splits large segments without exceeding aggregate bounds', async () => {
    const result = await extractBytes(text('甲乙\n\n第二段\n第三行'), 'txt', '/test.txt')
    expect(result.segments.map(({ label, text }) => [label, text])).toEqual([['段落 1', '甲乙'], ['段落 2', '第二段\n第三行']])
    expect(result.coverage).toBe('complete')
    const large = await extractBytes(text('x'.repeat(500010)), 'txt', '/large.txt')
    expect(large.segments.reduce((total, item) => total + item.text.length, 0)).toBe(500000)
    expect(large.segments.every((item) => item.text.length <= SOURCE_LIMITS.segmentCharacters)).toBe(true)
    expect(large.coverage).toBe('partial')
    const unicode = await extractBytes(text('x'.repeat(11999) + '😀尾段'), 'txt', '/unicode.txt')
    expect(unicode.segments[0].text).toHaveLength(11999)
    expect(unicode.segments[1].text).toBe('😀尾段')
  })
  it('caps segments and reports image-only or empty sources honestly', async () => {
    const many = await extractBytes(text(Array.from({ length: 1100 }, () => 'word').join('\n\n')), 'md', '/many.md')
    expect(many.segments).toHaveLength(1000)
    expect(many.coverageNote).toContain('上限')
    const empty = await extractBytes(new Uint8Array(), 'txt', '/empty.txt')
    expect(empty.coverage).toBe('partial')
    expect(empty.coverageNote).toContain('未执行 OCR')
  })
  it('reads quoted CSV cells including embedded newlines and quotes', async () => {
    const result = await extractBytes(text('name,quote\r\n甲,"第一行\n第二行 ""你好"""'), 'csv', '/test.csv')
    expect(result.segments[1]).toMatchObject({ label: '第 2 行', text: 'A2：甲 | B2：第一行\n第二行 "你好"' })
    expect(result.coverage).toBe('complete')
  })
  it('preserves cue time and removes subtitle formatting', async () => {
    const result = await extractBytes(text('WEBVTT\n\n00:01.250 --> 00:03.000 align:start\n<b>概念</b> &amp; 解释\n\n00:03.000 --> 00:04.000\n下一句'), 'vtt', '/test.vtt')
    expect(result.segments[0]).toMatchObject({ text: '概念 & 解释', startSeconds: 1.25, label: '00:01.250 → 00:03.000' })
    expect(result.segments).toHaveLength(2)
    expect(result.coverage).toBe('complete')
  })
  it('rejects oversized input, unsupported binary formats and invalid encoding', async () => {
    await expect(extractBytes(new Uint8Array(SOURCE_LIMITS.fileBytes + 1), 'txt', 'x')).rejects.toThrow('25 MiB')
    await expect(extractBytes(text('x'), 'exe', 'x')).rejects.toThrow('暂不支持')
    await expect(extractBytes(new Uint8Array([0xff, 0xff]), 'txt', 'x')).rejects.toThrow('编码')
  })
  it('extracts static HTML without scripts, navigation, hidden or duplicate nested text', () => {
    const result = extractHtml('<html><head><title>课程</title></head><body><nav>导航</nav><article><h1>标题</h1><p>正文 <strong>概念</strong></p><blockquote><p>引用</p></blockquote><script>globalThis.secret=1</script><p hidden>秘密</p></article></body></html>', { title: 'test', location: 'https://example.com/', format: 'html', kind: 'web' })
    expect(result.title).toBe('课程')
    expect(result.segments.map(({ text }) => text)).toEqual(['标题', '正文 概念', '引用'])
    expect(result.coverageNote).toContain('未运行网页脚本')
    expect(result.coverage).toBe('partial')
  })
  it('retains body-less HTML fragments and plain text received as HTML', () => {
    const context = { title: 'test', location: 'https://example.com/', format: 'html', kind: 'web' as const }
    expect(extractHtml('<p>第一段</p><div>第二段</div>', context).segments.map(({ text }) => text)).toEqual(['第一段', '第二段'])
    expect(extractHtml('纯文字', context).segments[0].text).toBe('纯文字')
    expect(extractHtml('', context).segments).toEqual([])
    expect(extractHtml('<html><head><title>标题</title></head><p>正文</p></html>', context).segments.map(({ text }) => text)).toEqual(['正文'])
  })
  it('rejects invalid subtitle minute/second values and ignores VTT notes containing timestamps', async () => {
    const result = await extractBytes(text('WEBVTT\n\nNOTE ignored\n00:01.000 --> 00:02.000\n注释不是字幕\n\n00:99.000 --> 01:00.000\n错误秒数\n\n00:02.000 --> 00:03.000\n有效字幕'), 'vtt', '/times.vtt')
    expect(result.segments.map(({ text }) => text)).toEqual(['有效字幕'])
    expect(result.coverageNote).toContain('时间范围不正确')
  })
})

describe('Office and PDF extraction', () => {
  it('extracts DOCX paragraphs, skips deleted text, and discloses missing layout', async () => {
    const bytes = office({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r><w:del><w:r><w:t>删除</w:t></w:r></w:del></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' })
    const result = await extractBytes(bytes, 'docx', '/test.docx')
    expect(result.segments.map(({ text }) => text)).toEqual(['第一段', '表格'])
    expect(result.coverageNote).toContain('未计算 Word 分页')
  })
  it('retains slide order and labels', async () => {
    const bytes = office({
      'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>第一页</a:t></a:r></a:p></p:sld>'
    })
    const result = await extractBytes(bytes, 'pptx', '/test.pptx')
    expect(result.segments.map(({ label, text }) => [label, text])).toEqual([['幻灯片 1', '第二页'], ['幻灯片 2', '第一页']])
  })
  it('retains XLSX sheet-cell addresses and uses saved formula results only', async () => {
    const bytes = office({
      'xl/workbook.xml': '<workbook><sheets><sheet name="收入" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>金额</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B2"><f>1+2</f><v>3</v></c><c r="C2"><f>2+3</f></c><c r="A2" t="inlineStr"><is><t>文字</t></is></c></row></sheetData></worksheet>'
    })
    const result = await extractBytes(bytes, 'xlsx', '/test.xlsx')
    expect(result.segments.map(({ label, text }) => [label, text])).toEqual([['收入 · A1', '金额'], ['收入 · B2', '3'], ['收入 · A2', '文字']])
    expect(result.warnings.join(' ')).toContain('未执行公式计算')
  })
  it('rejects broken zip and XML entity definitions', async () => {
    await expect(extractBytes(text('not zip'), 'docx', 'x')).rejects.toThrow('文档压缩')
    await expect(extractBytes(office({ 'word/document.xml': '<!DOCTYPE x [<!ENTITY a "secret">]><w:document>&a;</w:document>' }), 'docx', 'x')).rejects.toThrow('实体')
  })
  it('reads a real synthetic PDF text layer and page label', async () => {
    const stream = 'BT /F1 12 Tf 20 80 Td (Hello PDF) Tj ET'
    const pdf = `%PDF-1.4\n1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj\n3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>> endobj\n4 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj\n5 0 obj <</Length ${stream.length}>> stream\n${stream}\nendstream endobj\ntrailer <</Root 1 0 R>>\n%%EOF`
    const result = await extractBytes(text(pdf), 'pdf', '/test.pdf')
    expect(result.segments[0]).toMatchObject({ label: '第 1 页', text: 'Hello PDF' })
    expect(result.coverageNote).toContain('文字层')
  })
})

describe('public source boundaries', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::'])('rejects private or reserved address %s', (address) => expect(isPublicAddress(address)).toBe(false))
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows global address %s', (address) => expect(isPublicAddress(address)).toBe(true))
  it.each(['file:///etc/passwd', 'https://u:p@example.com', 'http://localhost', 'http://127.1', 'http://0x7f000001', 'http://example.com:8080', 'http://[::1]'])('rejects unsafe URL %s', (url) => expect(() => publicUrl(url)).toThrow())
  it('strips query secrets and fragments from persisted source location', () => {
    expect(redactedLocation(publicUrl('https://example.com/page?token=secret#anchor'))).toBe('https://example.com/page')
  })
  it('rejects a hostname resolving partly to private addresses before connecting', async () => {
    const resolveDns = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])
    await expect(fetchPublicBytes('https://example.com/secret?token=private', new AbortController().signal, { resolve: resolveDns })).rejects.toThrow('内网')
    expect(resolveDns).toHaveBeenCalledOnce()
  })
  it('refuses unsupported video pages instead of treating page metadata as the course', async () => {
    await expect(extractSourceCore({ kind: 'url', location: 'https://www.youtube.com/watch?v=test' }, new AbortController().signal, () => {})).rejects.toThrow('完整字幕')
  })
  it('reads selected regular files and honors an already cancelled task', async () => {
    await mkdir(scratch, { recursive: true })
    await writeFile(fixturePath, '正文一\n\n正文二')
    const progress: string[] = []
    const result = await extractSourceCore({ kind: 'file', location: fixturePath }, new AbortController().signal, (message) => progress.push(message))
    expect(result.segments).toHaveLength(2)
    expect(progress).toHaveLength(2)
    const abort = new AbortController(); abort.abort()
    await expect(extractSourceCore({ kind: 'file', location: fixturePath }, abort.signal, () => {})).rejects.toThrow()
    await expect(extractSourceCore({ kind: 'file', location: 'relative.txt' }, new AbortController().signal, () => {})).rejects.toThrow('绝对路径')
    await expect(extractSourceCore({ kind: 'file', location: '\\\\server\\share\\private.txt' }, new AbortController().signal, () => {})).rejects.toThrow('网络共享')
  })
})
