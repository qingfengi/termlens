import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.TERMLENS_PLAYWRIGHT_MODULE || 'playwright')
const root = path.resolve(import.meta.dirname, '..')
await mkdir(path.join(root, 'qa'), { recursive: true })
const data = await mkdtemp(path.join(root, 'qa', 'electron-'))
const server = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  const latest = body.messages.at(-1)?.content || ''
  if (body.stream === false) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ model: 'local-test' })); return }
  const content = latest.includes('举例') ? '例子：苹果和梨都属于水果，水果就是对共同特征的概括。' : JSON.stringify({ brief: '这是一条测试解释。', definition: '本地模拟服务用于验证解释保存流程。', related: ['概念'] })
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const env = { ...process.env, TERMLENS_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
let application
let window
const pageErrors = []
async function launch() {
  application = await _electron.launch({ executablePath: process.env.TERMLENS_TEST_EXECUTABLE || require('electron'), args: process.env.TERMLENS_TEST_EXECUTABLE ? [] : [root], env, timeout: 30000 })
  application.process().stderr.on('data', (chunk) => process.stderr.write(chunk))
  application.process().stdout.on('data', (chunk) => process.stdout.write(chunk))
  window = await application.firstWindow()
  window.on('pageerror', (error) => pageErrors.push(error.message))
  await window.waitForFunction(() => Boolean(window.termlens))
  await window.getByRole('heading', { name: '选中，就在这里解释' }).waitFor()
  assert.equal(await window.locator('#quick-text').count(), 0)
  const managerReady = application.waitForEvent('window')
  await window.getByRole('button', { name: '记录与设置', exact: true }).click()
  window = await managerReady
  window.on('pageerror', (error) => pageErrors.push(error.message))
  await window.waitForSelector('.app-header')
}
try {
  await launch()
  await window.evaluate(async (baseUrl) => {
    await window.termlens.providerUpsert({ id: 'test', name: '本地验收服务', protocol: 'openai', baseUrl, apiKey: '', model: 'local-test', timeoutMs: 5000, maxRetries: 0 })
    await window.termlens.readerSave({ title: '验收原文', text: '机器学习通过数据训练模型。' })
  }, baseUrl)
  const result = await window.evaluate(async () => {
    const found = await window.termlens.termDetect({ text: '概念' })
    const opened = await window.termlens.termDetail({ term: found.terms[0] })
    return window.termlens.termFollowup({ threadId: opened.thread.threadId, question: '可以举例吗？' })
  })
  assert.equal(result.messages.length, 2)
  assert.match(result.messages[1].content, /水果/)
  const fixture = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'verify-selection.ps1'), '-TriggerHotkey'], { windowsHide: true, env: { ...env, TEMP: path.join(root, 'qa'), TMP: path.join(root, 'qa') }, stdio: 'ignore' })
  let quickWindow
  try {
    quickWindow = application.windows().find((candidate) => candidate !== window)
    await quickWindow.waitForFunction(() => document.visibilityState === 'visible')
    await quickWindow.locator('.quick-detail h1').filter({ hasText: 'TermLens' }).waitFor()
    await quickWindow.screenshot({ path: path.join(data, 'native-selection-popup.png'), fullPage: true })
    await quickWindow.getByRole('button', { name: '收起', exact: true }).click()
  } finally { fixture.kill() }
  await window.evaluate(() => window.termlens.selectionConfigure({ automatic: true }))
  const automaticFixture = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'verify-selection.ps1'), '-HoldSelection'], { windowsHide: true, env: { ...env, TEMP: path.join(root, 'qa'), TMP: path.join(root, 'qa') }, stdio: 'ignore' })
  try {
    await quickWindow.waitForFunction(() => document.visibilityState === 'visible')
    await quickWindow.locator('.quick-detail h1').filter({ hasText: 'TermLens' }).waitFor()
  } finally {
    await window.evaluate(() => window.termlens.selectionConfigure({ automatic: false }))
    automaticFixture.kill()
    await quickWindow.getByRole('button', { name: '收起', exact: true }).click()
  }
  await window.screenshot({ path: path.join(data, 'reader-desktop.png'), fullPage: true })
  await window.evaluate(() => { location.hash = '/quick' })
  await window.getByRole('button', { name: /粘贴文字|编辑文字/ }).click()
  await window.waitForSelector('#quick-text')
  await window.locator('#quick-text').fill('机器学习')
  await window.getByRole('button', { name: '解释', exact: true }).click()
  await window.locator('.quick-detail h1').filter({ hasText: '机器学习' }).waitFor()
  await window.locator('#quick-question').fill('举例')
  await window.getByRole('button', { name: '发送', exact: true }).click()
  await window.locator('.quick-messages').getByText(/水果/).waitFor()
  await window.screenshot({ path: path.join(data, 'quick-desktop.png'), fullPage: true })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => !candidate.isAlwaysOnTop()).setSize(390, 760))
  await window.waitForFunction(() => innerWidth <= 390)
  await window.screenshot({ path: path.join(data, 'quick-mobile-width.png'), fullPage: true })
  assert.equal(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await application.close()
  application = undefined
  await launch()
  const restored = await window.evaluate(async () => ({ docs: await window.termlens.readerList(), history: await window.termlens.termHistory() }))
  assert(restored.docs.some((document) => document.title === '验收原文'))
  assert(restored.history.some((thread) => thread.messages.some((message) => message.content.includes('水果'))))
  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({ ok: true, checks: ['real Electron bridge', 'native selection global shortcut popup', 'automatic selection popup', 'local model request', 'quick definition', 'followup', '390px overflow', 'restart persistence'], screenshots: data }))
} finally {
  if (application) await application.close().catch(() => {})
  await new Promise((resolve) => server.close(resolve))
}
