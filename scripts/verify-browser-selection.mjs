import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Uses a fresh Edge profile and a synthetic page; never attaches to a user's tabs.
const root = path.resolve(import.meta.dirname, '..')
await mkdir(path.join(root, 'qa'), { recursive: true })
const profile = await mkdtemp(path.join(root, 'qa', 'edge-selection-'))
const browser = await chromium.launchPersistentContext(profile, {
  channel: 'msedge', headless: false, args: ['--force-renderer-accessibility'],
  env: { ...process.env, TEMP: profile, TMP: profile }
})
let helper
try {
  const page = browser.pages()[0]
  await page.setContent('<html lang="zh-CN"><head><title>TermLens controlled browser fixture</title></head><body><p id="selection">机器学习</p><p>TermLens controlled browser fixture</p></body></html>')
  await page.bringToFront()
  await page.locator('#selection').click()
  await page.evaluate(() => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('#selection'))
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  })
  await page.waitForFunction(() => document.hasFocus() && getSelection().toString() === '机器学习')
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'selected-text.ps1')], {
    windowsHide: true, env: { ...process.env, TEMP: profile, TMP: profile }, stdio: ['pipe', 'pipe', 'pipe']
  })
  const selected = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native browser selection timed out')), 10000)
    let output = ''
    helper.stdout.setEncoding('utf8')
    helper.stdout.on('data', (part) => {
      output += part
      if (!output.includes('\n')) return
      clearTimeout(timer)
      try { resolve(JSON.parse(output.split('\n')[0])) } catch (error) { reject(error) }
    })
    helper.on('error', (error) => { clearTimeout(timer); reject(error) })
    helper.on('exit', () => { clearTimeout(timer); reject(new Error('Selection helper exited')) })
    helper.stdin.write('read\n')
  })
  assert.equal(selected.text, '机器学习')
  await page.screenshot({ path: path.join(profile, 'selected-page.png') })
  console.log('PASS: Windows UI Automation read Chinese selected text from isolated Edge page (accessibility enabled).')
} finally {
  helper?.kill()
  await browser.close()
}
