import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppKernel } from '../../src/main/kernel/app-kernel'
import { registerIpc } from '../../src/main/kernel/register-ipc'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>(),
  window: {},
  fromWebContents: vi.fn(),
  owns: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, action: (event: unknown, input: unknown) => Promise<unknown>) => ipc.handlers.set(name, action) },
  BrowserWindow: { fromWebContents: ipc.fromWebContents }
}))

const draft = { protocol: 'openai', baseUrl: 'https://example.test', apiKey: 'test-draft-key' }
const config = {
  getRaw: () => ({ providers: [{ apiKey: 'test-stored-key' }] }),
  resolveProviderApiKey: vi.fn(),
  upsertProvider: vi.fn(),
  update: vi.fn()
}
const frame = {}
const event = { sender: { mainFrame: frame }, senderFrame: frame }
function invoke(input: unknown, requestEvent: unknown = event) {
  const action = ipc.handlers.get('provider:models')
  if (!action) throw new Error('provider:models handler was not registered')
  return action(requestEvent, input)
}

beforeEach(() => {
  ipc.handlers.clear()
  ipc.fromWebContents.mockReturnValue(ipc.window)
  ipc.owns.mockReturnValue(true)
  config.resolveProviderApiKey.mockImplementation((input: { apiKey: string }) => input.apiKey)
  registerIpc({ config, repo: {}, terms: {}, windows: { owns: ipc.owns } } as unknown as AppKernel)
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('model discovery IPC boundary', () => {
  it('accepts an unsaved draft and does not persist it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[{"id":"test-model"}]}')))
    await expect(invoke(draft)).resolves.toEqual({ baseUrl: 'https://example.test/v1', models: [{ id: 'test-model' }] })
    expect(config.resolveProviderApiKey).toHaveBeenCalledWith(draft)
    expect(config.upsertProvider).not.toHaveBeenCalled()
    expect(config.update).not.toHaveBeenCalled()
  })

  it('resolves masked keys inside the main process before the request', async () => {
    const fetch = vi.fn(async () => new Response('{"data":[]}'))
    vi.stubGlobal('fetch', fetch)
    config.resolveProviderApiKey.mockReturnValue('test-stored-key')
    const result = await invoke({ ...draft, id: 'saved', apiKey: '••••••••' })
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-stored-key' }) }))
    expect(JSON.stringify(result)).not.toContain('test-stored-key')
  })

  it('does not send a request when saved credential resolution refuses it', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    config.resolveProviderApiKey.mockImplementation(() => { throw new Error('服务地址或协议已更改，请重新输入密钥。') })
    await expect(invoke({ ...draft, id: 'saved', apiKey: '••••••••' })).rejects.toThrow('重新输入密钥')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('redacts both draft and stored keys even in unexpected main-process errors', async () => {
    config.resolveProviderApiKey.mockImplementation(() => { throw new Error(`Unexpected ${draft.apiKey} test-stored-key`) })
    await expect(invoke(draft)).rejects.toThrow('Unexpected [已隐藏] [已隐藏]')
  })

  it('validates the draft before credential lookup or network access', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const input of [null, { ...draft, apiKey: 'x'.repeat(8193) }, { ...draft, baseUrl: 'http://external.test' }, { ...draft, model: 'unused' }]) {
      await expect(invoke(input)).rejects.toThrow('输入格式')
    }
    expect(config.resolveProviderApiKey).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects foreign windows and child-frame calls before examining credentials', async () => {
    ipc.fromWebContents.mockReturnValueOnce(null)
    await expect(invoke(draft)).rejects.toThrow('请求来源')
    ipc.owns.mockReturnValueOnce(false)
    await expect(invoke(draft)).rejects.toThrow('请求来源')
    await expect(invoke(draft, { ...event, senderFrame: {} })).rejects.toThrow('请求来源')
    expect(config.resolveProviderApiKey).not.toHaveBeenCalled()
  })
})
