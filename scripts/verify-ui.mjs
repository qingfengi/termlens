import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.TERMLENS_PLAYWRIGHT_MODULE || 'playwright')
const root = path.resolve(import.meta.dirname, '..')
await mkdir(path.join(root, 'qa'), { recursive: true })
const data = await mkdtemp(path.join(root, 'qa', 'electron-'))
let catalogMode = 'success'
let catalogRequests = 0
const fixtureKey = 'termlens-fixture-credential'
const server = createServer(async (request, response) => {
  if (request.method === 'GET') {
    catalogRequests++
    assert.equal(request.url, '/v1/models')
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`)
    if (catalogMode === 'unauthorized') { response.writeHead(401); response.end('credentials must never appear in the UI'); return }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: catalogMode === 'empty' ? [] : [{ id: 'local-test', name: '本地文字模型' }, { id: 'alternate-model' }] }))
    return
  }
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
  await window.evaluate(() => { location.hash = '/settings' })
  await window.locator('.page-toolbar').getByRole('button', { name: '添加 AI 服务', exact: true }).click()
  await window.getByLabel('服务地址', { exact: true }).fill(baseUrl.replace(/\/v1$/, ''))
  await window.getByLabel('API 密钥', { exact: true }).fill(fixtureKey)
  await window.getByRole('button', { name: '获取模型列表', exact: true }).click()
  await window.getByLabel('可用模型', { exact: true }).waitFor()
  assert.equal(await window.getByLabel('模型名称', { exact: true }).inputValue(), '')
  assert.equal(await window.getByLabel('服务地址', { exact: true }).inputValue(), baseUrl)
  await window.getByLabel('可用模型', { exact: true }).selectOption('local-test')
  await window.getByLabel('服务名称', { exact: true }).fill('模型发现验收')
  await window.getByRole('button', { name: '保存服务', exact: true }).click()
  await window.getByText('服务配置已保存', { exact: true }).waitFor()
  assert.equal(await window.getByLabel('API 密钥', { exact: true }).inputValue(), '')
  await window.getByRole('button', { name: '获取模型列表', exact: true }).click()
  await window.getByLabel('可用模型', { exact: true }).waitFor()
  await window.getByRole('button', { name: '测试连接', exact: true }).click()
  await window.getByText(/连接成功/).waitFor()
  assert.equal((await readFile(path.join(data, 'settings.json'), 'utf8')).includes(fixtureKey), false)
  assert.equal((await readFile(path.join(data, 'secrets.dat'), 'utf8')).includes(fixtureKey), false)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => !candidate.isAlwaysOnTop()).setSize(390, 760))
  await window.waitForFunction(() => innerWidth <= 390)
  assert.equal(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await window.screenshot({ path: path.join(data, 'models-mobile-width.png'), fullPage: true })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => !candidate.isAlwaysOnTop()).setSize(1100, 780))
  const beforeChangedAddress = catalogRequests
  await window.getByLabel('服务地址', { exact: true }).fill(`${baseUrl}/different-service`)
  assert.equal(await window.getByLabel('可用模型', { exact: true }).count(), 0)
  await window.getByRole('button', { name: '获取模型列表', exact: true }).click()
  await window.locator('.notice-error').waitFor()
  assert.equal(catalogRequests, beforeChangedAddress)
  assert.equal((await window.locator('.notice-error').innerText()).includes(fixtureKey), false)
  await window.getByLabel('服务地址', { exact: true }).fill(baseUrl)
  catalogMode = 'unauthorized'
  await window.getByRole('button', { name: '获取模型列表', exact: true }).click()
  await window.locator('.notice-error').waitFor()
  assert.equal((await window.locator('.notice-error').innerText()).includes('credentials must never'), false)
  catalogMode = 'empty'
  await window.getByRole('button', { name: '获取模型列表', exact: true }).click()
  await window.getByText('服务没有返回可选模型，仍可手动填写模型名称。', { exact: true }).waitFor()
  await window.getByLabel('模型名称', { exact: true }).fill('manual-model')
  await window.getByRole('button', { name: '保存服务', exact: true }).click()
  await window.getByText('服务配置已保存', { exact: true }).waitFor()
  const savedCatalogProvider = await window.evaluate(async () => (await window.termlens.configGet()).providers[0])
  assert.equal(savedCatalogProvider.model, 'manual-model')
  assert.equal(savedCatalogProvider.apiKey, '••••••••')
  await window.getByLabel('术语默认服务', { exact: true }).selectOption(savedCatalogProvider.id)
  await window.getByText('术语默认服务已保存', { exact: true }).waitFor()
  await window.getByLabel('术语默认服务', { exact: true }).selectOption('')
  await window.waitForFunction(async () => {
    const config = await window.termlens.configGet()
    return ['termBrief', 'termDetail', 'termFollowup'].every((feature) => config.featureBindings[feature] === '')
  })
  await window.evaluate(async (id) => window.termlens.providerRemove(id), savedCatalogProvider.id)
  catalogMode = 'success'
  await window.evaluate(() => { location.hash = '/reader' })
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
  async function waitForQuickVisibility(expected) {
    for (let attempt = 0; attempt < 250; attempt++) {
      const visible = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.isAlwaysOnTop()).isVisible())
      if (visible === expected) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const state = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((candidate) => ({ id: candidate.id, quick: candidate.isAlwaysOnTop(), visible: candidate.isVisible(), focused: candidate.isFocused(), minimized: candidate.isMinimized() })))
    assert.fail(`Expected quick window visible=${expected}; native state: ${JSON.stringify(state)}`)
  }
  async function closeQuickWindow() {
    await waitForQuickVisibility(true)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.isAlwaysOnTop()).focus())
    await quickWindow.bringToFront()
    try { await quickWindow.getByRole('button', { name: '关闭浮窗', exact: true }).click() }
    catch (failure) {
      console.error(JSON.stringify({ check: 'close quick window', windows: await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((candidate) => ({ id: candidate.id, quick: candidate.isAlwaysOnTop(), visible: candidate.isVisible(), focused: candidate.isFocused(), minimized: candidate.isMinimized() }))) }))
      await quickWindow.screenshot({ path: path.join(data, 'close-popup-failure.png'), timeout: 3000 }).catch(() => {})
      throw failure
    }
    await waitForQuickVisibility(false)
  }
  const fixture = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'verify-selection.ps1'), '-TriggerHotkey'], { windowsHide: true, env: { ...env, TEMP: path.join(root, 'qa'), TMP: path.join(root, 'qa') }, stdio: 'ignore' })
  let quickWindow
  try {
    quickWindow = application.windows().find((candidate) => candidate !== window)
    await waitForQuickVisibility(true)
    await quickWindow.locator('.quick-detail h1').filter({ hasText: 'TermLens' }).waitFor()
    await quickWindow.screenshot({ path: path.join(data, 'native-selection-popup.png'), fullPage: true })
  } finally { fixture.kill() }
  await quickWindow.locator('#quick-question').fill('举例')
  await quickWindow.getByRole('button', { name: '发送', exact: true }).click()
  await quickWindow.locator('.quick-messages').getByText(/水果/).waitFor()
  const retainedContent = await quickWindow.locator('.quick-detail').innerText()
  for (const draft of ['', '这条追问还没发送']) {
    await quickWindow.locator('#quick-question').fill(draft)
    const previousSelectionId = await quickWindow.evaluate(async () => (await window.termlens.selectionGet()).id)
    await closeQuickWindow()
    await window.bringToFront()
    const reopen = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+ ')"], { windowsHide: true, env: { ...env, TEMP: path.join(root, 'qa'), TMP: path.join(root, 'qa') }, stdio: 'ignore' })
    try {
      await waitForQuickVisibility(true)
      await quickWindow.bringToFront()
      await quickWindow.waitForFunction(async (previousId) => {
        const selection = await window.termlens.selectionGet()
        return selection.id > previousId && selection.text === ''
      }, previousSelectionId, { polling: 100 })
      await quickWindow.getByText(/未读到选中文字/).waitFor()
      assert.equal(await quickWindow.locator('.quick-detail').innerText(), retainedContent)
      assert.equal(await quickWindow.locator('.quick-annotated').innerText(), 'TermLens')
      assert.equal(await quickWindow.locator('#quick-question').inputValue(), draft)
      assert.equal(await quickWindow.locator('.quick-queued').count(), 0)
    } finally { reopen.kill() }
  }
  await quickWindow.locator('#quick-question').fill('')
  await closeQuickWindow()
  await window.bringToFront()
  const beforeAutomaticSelection = await window.evaluate(async () => (await window.termlens.selectionGet()).id)
  await window.evaluate(() => window.termlens.selectionConfigure({ automatic: true }))
  const automaticFixture = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'verify-selection.ps1'), '-HoldSelection'], { windowsHide: true, env: { ...env, TEMP: path.join(root, 'qa'), TMP: path.join(root, 'qa') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let automaticFixtureOutput = ''
  for (const stream of [automaticFixture.stdout, automaticFixture.stderr]) stream.on('data', (chunk) => { automaticFixtureOutput += chunk })
  try {
    await waitForQuickVisibility(true)
    await quickWindow.waitForFunction(async (previousId) => {
      const selection = await window.termlens.selectionGet()
      return selection.id > previousId && selection.automatic && selection.text === 'TermLens'
    }, beforeAutomaticSelection, { polling: 100 })
    await quickWindow.locator('.quick-detail h1').filter({ hasText: 'TermLens' }).waitFor()
  } catch (failure) {
    console.error(JSON.stringify({ check: 'automatic selection', fixtureExitCode: automaticFixture.exitCode, fixtureOutput: automaticFixtureOutput, selection: await window.evaluate(async () => { const { text, ...selection } = await window.termlens.selectionGet(); return { ...selection, textLength: text.length } }), enabled: await window.evaluate(async () => (await window.termlens.configGet()).term.selectionAuto) }))
    throw failure
  } finally {
    await window.evaluate(() => window.termlens.selectionConfigure({ automatic: false }))
    automaticFixture.kill()
    if (await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.isAlwaysOnTop()).isVisible())) await closeQuickWindow()
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
  console.log(JSON.stringify({ ok: true, checks: ['real Electron bridge', 'draft and saved credential model discovery', 'model selection/manual fallback/save/test', 'changed address credential protection', 'empty and unauthorized model lists', 'encrypted credential storage', 'default service reset', 'native selection global shortcut popup', 'close and hotkey reopen preserve explanation and draft without selection', 'automatic selection popup', 'local model request', 'quick definition', 'followup', '390px overflow', 'restart persistence'], screenshots: data }))
} finally {
  if (application) await application.close().catch(() => {})
  await new Promise((resolve) => server.close(resolve))
}
