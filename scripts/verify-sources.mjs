import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { zipSync, strToU8 } from 'fflate'

const require = createRequire(import.meta.url)
const { _electron } = require('playwright')
const root = path.resolve(import.meta.dirname, '..')
await mkdir(path.join(root, 'qa'), { recursive: true })
const data = await mkdtemp(path.join(root, 'qa', 'sources-ui-'))
const textPath = path.join(data, '阅读样本.txt')
await writeFile(textPath, '机器学习需要样本。\n\n差分隐私限制单条数据的影响。')
const office = (files) => zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])))
await writeFile(path.join(data, 'sample.docx'), office({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>文档中的机器学习</w:t></w:r></w:p></w:body></w:document>' }))
await writeFile(path.join(data, 'sample.srt'), '1\n00:00:01,000 --> 00:00:03,000\n课程中的机器学习\n')
await writeFile(path.join(data, 'invalid.pdf'), 'not a pdf')
let requestMode = 'success'
let requestCount = 0
const server = createServer(async (request, response) => {
  requestCount++
  let raw = ''
  for await (const part of request) raw += part
  const body = JSON.parse(raw)
  if (requestMode === 'hold') return
  let answer
  if (body.messages[0].content.includes('识别资料中的专业术语')) answer = { terms: ['机器学习', '差分隐私', '原文不存在的术语'] }
  else if (body.messages[0].content.includes('解释用户选中的整段学习材料')) answer = { summary: '这段资料介绍学习概念。', termExplanations: [{ surface: '机器学习', explanation: '从数据中学习规律。' }], context: '' }
  else {
    const input = JSON.parse(body.messages.at(-1).content)
    if (!Array.isArray(input.excerpts)) answer = { summary: '这段资料介绍学习概念。', termExplanations: [{ surface: '机器学习', explanation: '从数据中学习规律。' }], context: '' }
    else {
      assert(input.excerpts.length <= 6)
      answer = requestMode === 'bad-citation' ? { answer: 'invalid', citationIds: ['invented'] } : { answer: '根据原文，差分隐私限制单条数据的影响。', citationIds: [input.excerpts[0].id] }
    }
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(answer) } }] })}\n\ndata: [DONE]\n\n`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const env = { ...process.env, TERMLENS_DATA_DIR: data, TEMP: data, TMP: data }
delete env.ELECTRON_RUN_AS_NODE
let application, window, nativeFixture
const errors = []
async function launch() {
  application = await _electron.launch({ executablePath: process.env.TERMLENS_TEST_EXECUTABLE || require('electron'), args: process.env.TERMLENS_TEST_EXECUTABLE ? [] : [root], env, timeout: 30000 })
  const quick = await application.firstWindow()
  await quick.waitForFunction(() => Boolean(window.termlens))
  const ready = application.waitForEvent('window')
  await quick.getByRole('button', { name: '资料阅读', exact: true }).click()
  window = await ready
  window.on('pageerror', (error) => errors.push(error.message))
  await window.getByRole('heading', { name: '资料阅读', exact: true }).waitFor()
}
async function finished(id) {
  for (let attempt = 0; attempt < 450; attempt++) {
    const task = await window.evaluate(async (id) => (await window.termlens.sourceStatus()).tasks.find((task) => task.id === id), id)
    if (task && !['running', 'queued'].includes(task.state)) return task
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`task ${id} did not finish`)
}
async function importFile(location) {
  const task = await window.evaluate((location) => window.termlens.sourceImport({ kind: 'file', location }), location)
  return finished(task.id)
}
try {
  await launch()
  await window.getByRole('button', { name: '暂停助手', exact: true }).click()
  await window.getByLabel('资料网址或文件路径').fill(textPath)
  await window.getByRole('button', { name: '开始读取', exact: true }).click()
  await window.getByRole('status').filter({ hasText: '等待处理' }).waitFor()
  assert.equal((await window.evaluate(() => window.termlens.sourceList())).length, 0)
  await window.getByRole('button', { name: '继续助手', exact: true }).click()
  await window.locator('.source-title h2').filter({ hasText: '阅读样本.txt' }).waitFor()
  const source = await window.evaluate(async () => window.termlens.sourceGet((await window.termlens.sourceList())[0].id))
  assert.equal(source.coverage, 'complete')
  assert.equal(source.segments.length, 2)
  await window.getByRole('button', { name: '识别全部段落术语', exact: true }).click()
  await window.locator('.source-segments .term-mark').first().waitFor()
  assert.equal(requestCount, 0)
  await window.getByText('AI 已分析 0/2 段。', { exact: false }).waitFor()
  await window.evaluate(async (baseUrl) => {
    await window.termlens.providerUpsert({ id: 'source-test', name: '资料验收', protocol: 'openai', baseUrl, model: 'fixture', apiKey: '', timeoutMs: 5000, maxRetries: 0 })
    await window.termlens.configUpdate({ featureBindings: { termDetail: 'source-test', termFollowup: 'source-test' } })
  }, baseUrl)
  await window.getByLabel('使用 AI 识别术语', { exact: true }).check()
  await window.getByRole('button', { name: '识别全部段落术语', exact: true }).click()
  await window.getByText('AI 已分析 2/2 段。', { exact: false }).waitFor()
  assert.equal(await window.locator('.source-segments .term-mark').filter({ hasText: '原文不存在' }).count(), 0)
  await window.locator('.source-segments .term-mark').filter({ hasText: '差分隐私' }).first().click()
  await window.locator('.source-conversation .message-assistant').waitFor()
  await window.locator('.source-citations button').first().click()
  await window.waitForFunction(() => document.querySelector('.source-segment.selected h3')?.textContent === '段落 2')
  await window.locator('#source-question').fill('它与机器学习有什么关系？')
  await window.getByRole('button', { name: '发送问题', exact: true }).click()
  await window.waitForFunction(() => document.querySelectorAll('.source-conversation .message-assistant').length === 2)
  await window.screenshot({ path: path.join(data, 'sources-desktop.png'), fullPage: true })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => !candidate.isAlwaysOnTop()).setSize(390, 760))
  await window.waitForFunction(() => innerWidth <= 390)
  assert.equal(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await window.screenshot({ path: path.join(data, 'sources-narrow.png'), fullPage: true })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => !candidate.isAlwaysOnTop()).setSize(1100, 780))
  requestMode = 'bad-citation'
  let task = await window.evaluate((id) => window.termlens.sourceAsk({ id, question: '不能接受伪造出处' }), source.id)
  assert.equal((await finished(task.id)).state, 'failed')
  let saved = await window.evaluate((id) => window.termlens.sourceGet(id), source.id)
  assert(saved.messages.at(-1).error)
  assert.equal(saved.messages.length, 5)
  requestMode = 'hold'
  const before = requestCount
  task = await window.evaluate((id) => window.termlens.sourceAsk({ id, question: '停止测试' }), source.id)
  while (requestCount === before) await new Promise((resolve) => setTimeout(resolve, 50))
  await window.getByRole('button', { name: '暂停助手', exact: true }).click()
  assert.equal((await finished(task.id)).state, 'cancelled')
  await window.waitForFunction(async (id) => (await window.termlens.sourceGet(id)).messages.at(-1).error, source.id)
  await application.close()
  application = undefined
  requestMode = 'success'
  await launch()
  await window.getByRole('button', { name: '继续助手', exact: true }).waitFor()
  saved = await window.evaluate((id) => window.termlens.sourceGet(id), source.id)
  assert.equal(saved.messages.length, 6)
  assert.equal(saved.analysis, 'complete')
  assert.equal(saved.segments[1].terms[0].surface, '差分隐私')
  await window.getByRole('button', { name: '继续助手', exact: true }).click()
  const docx = await importFile(path.join(data, 'sample.docx'))
  assert.equal(docx.state, 'complete')
  assert.equal((await window.evaluate((id) => window.termlens.sourceGet(id), docx.sourceId)).coverage, 'partial')
  const subtitle = await importFile(path.join(data, 'sample.srt'))
  assert.equal(subtitle.state, 'complete')
  assert.equal((await window.evaluate((id) => window.termlens.sourceGet(id), subtitle.sourceId)).segments[0].startSeconds, 1)
  const pdfFixture = path.join(root, 'qa', 'source-extract-tests', 'worker-fixture.pdf')
  try {
    await readFile(pdfFixture)
    assert.equal((await importFile(pdfFixture)).state, 'complete')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  assert.equal((await importFile(path.join(data, 'invalid.pdf'))).state, 'failed')
  task = await window.evaluate(() => window.termlens.sourceImport({ kind: 'url', location: 'http://127.0.0.1/private' }))
  assert.equal((await finished(task.id)).state, 'failed')
  task = await window.evaluate(() => window.termlens.sourceImport({ kind: 'url', location: 'https://www.youtube.com/watch?v=fixture' }))
  assert.equal((await finished(task.id)).state, 'failed')
  await assert.rejects(() => window.evaluate(() => window.termlens.sourceImport({ kind: 'window' })), /Ctrl\+Shift\+R/)
  await assert.rejects(() => window.evaluate((id) => window.termlens.sourceAsk({ id, question: '' }), source.id), /输入格式/)
  // 当前窗口读取依赖真实前台焦点，单独由 verify-selection.ps1 做原生验收；这里验证 IPC 要求使用快捷键，避免测试改变用户桌面焦点。
  await window.bringToFront()
  await window.getByRole('button', { name: /阅读样本.txt.*txt/ }).click()
  await window.locator('.source-title h2').filter({ hasText: '阅读样本.txt' }).waitFor()
  window.once('dialog', (dialog) => dialog.accept())
  await window.getByRole('button', { name: '删除资料', exact: true }).click()
  await window.waitForFunction(async (id) => !(await window.termlens.sourceGet(id)), source.id)
  assert.equal(await readFile(textPath, 'utf8'), '机器学习需要样本。\n\n差分隐私限制单条数据的影响。')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, checks: ['file queue/pause/resume', 'worker DOCX/SRT/PDF', 'local and AI term marking', 'contextual explanation and followup', 'real excerpt citations', 'fabricated citation rejection', 'cancel active AI', 'pause and source persistence after restart', 'unsafe URL rejection', 'current-window IPC guard', '390px overflow', 'delete keeps original file'], data }))
} finally {
  nativeFixture?.kill()
  if (application) await application.close().catch(() => {})
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
