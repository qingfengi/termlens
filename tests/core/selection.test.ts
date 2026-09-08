import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SelectionService } from '../../src/main/kernel/selection-service'

const native = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '.', getAppPath: () => '.', isPackaged: false } }))
vi.mock('node:child_process', () => ({ spawn: native.spawn }))
vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }))

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: new EventEmitter(), stdin: { write: vi.fn() }, kill: vi.fn()
  })
}

let service: SelectionService
let processMock: ReturnType<typeof child>
const show = vi.fn<ConstructorParameters<typeof SelectionService>[0]>()
beforeEach(() => {
  vi.useFakeTimers()
  processMock = child()
  native.spawn.mockReset().mockReturnValue(processMock)
  show.mockReset()
  service = new SelectionService((snapshot, automatic) => show(snapshot, automatic))
})
afterEach(() => { service.dispose(); vi.useRealTimers() })

describe.skipIf(process.platform !== 'win32')('Windows selection lifecycle', () => {
  it('discards an automatic read when the user switches it off, including off/on', async () => {
    service.configure(true)
    const pending = service.capture(true)
    service.configure(false)
    service.configure(true)
    processMock.stdout.emit('data', JSON.stringify({ text: 'old selection' }) + '\n')
    await pending
    expect(show).not.toHaveBeenCalled()
    service.configure(false)
    await service.capture(true)
    expect(processMock.stdin.write).toHaveBeenCalledTimes(1)
  })

  it('deduplicates automatic reads but lets manual requests reopen a selection', async () => {
    service.configure(true)
    for (const automatic of [true, true, false]) {
      const pending = service.capture(automatic)
      processMock.stdout.emit('data', '{"text":"concept"}\n')
      await pending
    }
    expect(show).toHaveBeenCalledTimes(2)
    expect(service.snapshot).toMatchObject({ id: 2, text: 'concept', automatic: false })
  })

  it('times out and restarts without stale process callbacks corrupting the next request', async () => {
    const first = service.capture()
    await vi.advanceTimersByTimeAsync(6000)
    await first
    expect(processMock.kill).toHaveBeenCalledOnce()
    expect(service.snapshot.error).toBeTruthy()
    const fresh = child()
    native.spawn.mockReturnValue(fresh)
    const second = service.capture()
    processMock.emit('error', new Error('late error'))
    processMock.emit('exit')
    processMock.stdout.emit('data', 'invalid\n')
    fresh.stdout.emit('data', '{"text":"fresh"}\n')
    await second
    expect(service.snapshot.text).toBe('fresh')
    expect(fresh.kill).not.toHaveBeenCalled()
  })

  it('settles pending reads and stops timers when disposed', async () => {
    service.configure(true)
    const pending = service.capture(true)
    service.dispose()
    await pending
    await vi.advanceTimersByTimeAsync(10000)
    service.configure(true)
    await service.capture()
    expect(show).not.toHaveBeenCalled()
    expect(native.spawn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects malformed output and handles process launch failures', async () => {
    const pending = service.capture()
    processMock.stdout.emit('data', 'invalid\n')
    await pending
    expect(processMock.kill).toHaveBeenCalledOnce()
    native.spawn.mockImplementation(() => { throw new Error('unavailable') })
    await expect(service.capture()).resolves.toBeUndefined()
    expect(service.snapshot.text).toBe('')
    expect(service.snapshot.error).toBeTruthy()
  })
})
