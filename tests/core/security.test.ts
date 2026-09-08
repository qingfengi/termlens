import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SecureStore, secretKeys } from '../../src/main/config/secure-store'
import { ConfigService } from '../../src/main/config/config-service'
import { providerConfigSchema } from '../../src/shared/config/schema'

const encryption = vi.hoisted(() => ({ enabled: true, calls: 0, failAt: 0 }))
const disk = vi.hoisted(() => ({ failWrite: '', failRename: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (String(args[0]) === disk.failWrite) throw new Error('test disk write failure')
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (String(args[1]) === disk.failRename) throw new Error('test disk rename failure')
      return actual.renameSync(...args)
    }
  }
})
vi.mock('electron', () => ({
  app: { getPath: () => '.' },
  safeStorage: {
    isEncryptionAvailable: () => encryption.enabled,
    encryptString: (text: string) => {
      encryption.calls += 1
      if (encryption.calls === encryption.failAt) throw new Error('test encryption failure')
      return Buffer.from(`TEST_ENCRYPTED:${text}`)
    },
    decryptString: (buffer: Buffer) => buffer.toString().replace('TEST_ENCRYPTED:', '')
  }
}))
let folder: string
beforeEach(() => {
  encryption.enabled = true
  encryption.calls = 0
  encryption.failAt = 0
  disk.failWrite = ''
  disk.failRename = ''
  mkdirSync(join(process.cwd(), 'qa'), { recursive: true })
  folder = mkdtempSync(join(process.cwd(), 'qa', 'security-test-'))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

describe('secret and input boundaries', () => {
  it('refuses to persist a secret without platform encryption', () => {
    encryption.enabled = false
    const path = join(folder, 'secrets.dat')
    const store = new SecureStore(path)
    expect(() => store.set('key', 'test-only-secret')).toThrow('系统加密不可用')
    expect(store.get('key')).toBe('')
    expect(existsSync(path)).toBe(false)
  })
  it('keeps secrets out of public configuration and masks renderer snapshots', () => {
    const config = new ConfigService(join(folder, 'settings.json'), new SecureStore(join(folder, 'secrets.dat')))
    config.upsertProvider({ id: 'test', name: 'Test', protocol: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'test-only-secret', model: 'model', timeoutMs: 1000, maxRetries: 0 })
    expect(readFileSync(join(folder, 'settings.json'), 'utf8')).not.toContain('test-only-secret')
    expect(config.getSafe().providers[0].apiKey).not.toBe('test-only-secret')
    config.update({ providers: config.getSafe().providers })
    expect(config.getRaw().providers[0].apiKey).toBe('test-only-secret')
  })
  it('rejects unsafe provider URLs and accepts explicit local services', () => {
    const config = { id: 'test', name: 'test', protocol: 'openai', model: 'model' }
    for (const baseUrl of ['http://external.example/v1', 'file:///test', 'https://user:pass@example.test/v1', 'https://example.test/v1?key=test']) expect(providerConfigSchema.safeParse({ ...config, baseUrl }).success).toBe(false)
    expect(providerConfigSchema.safeParse({ ...config, baseUrl: 'http://127.0.0.1:1234/v1' }).success).toBe(true)
  })
  it('rejects prototype mutation and leaves previous configuration on failed saving', () => {
    const config = new ConfigService(join(folder, 'settings.json'), new SecureStore(join(folder, 'secrets.dat')))
    expect(() => config.update(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow('字段')
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    encryption.enabled = false
    const fresh = new ConfigService(join(folder, 'other.json'), new SecureStore(join(folder, 'other.dat')))
    expect(() => fresh.upsertProvider({ id: 'a', name: 'a', protocol: 'openai', baseUrl: 'https://example.test', apiKey: 'test-only-secret', model: 'model', timeoutMs: 1000, maxRetries: 0 })).toThrow()
    expect(fresh.getSafe().providers).toEqual([])
  })
})

describe('configuration and credential rollback', () => {
  const provider = (id: string, apiKey: string) => ({
    id, name: id, protocol: 'openai' as const, baseUrl: 'https://example.test/v1',
    apiKey, model: 'model', timeoutMs: 1000, maxRetries: 0
  })

  function setup() {
    const settingsPath = join(folder, 'settings.json')
    const secretsPath = join(folder, 'secrets.dat')
    const secure = new SecureStore(secretsPath)
    const config = new ConfigService(settingsPath, secure)
    config.update({ providers: [provider('one', 'test-old-one'), provider('two', 'test-old-two')] })
    config.update({ featureBindings: { termBrief: 'one' } })
    secure.set(secretKeys.developerPassphraseHash(), 'test-developer-hash')
    return { settingsPath, secretsPath, secure, config }
  }

  it.each(['write', 'rename'] as const)('restores an edited key when settings %s fails', (operation) => {
    const { settingsPath, secretsPath, secure, config } = setup()
    const oldSettings = readFileSync(settingsPath)
    const oldSecrets = readFileSync(secretsPath)
    const before = config.getSafe()
    const changed = vi.fn()
    config.on('changed', changed)
    if (operation === 'write') disk.failWrite = `${settingsPath}.tmp`
    else disk.failRename = settingsPath

    expect(() => config.upsertProvider(provider('one', 'test-new-one'))).toThrow('test disk')
    expect(config.getSafe()).toEqual(before)
    expect(secure.get(secretKeys.providerApiKey('one'))).toBe('test-old-one')
    expect(new SecureStore(secretsPath).get(secretKeys.providerApiKey('one'))).toBe('test-old-one')
    expect(readFileSync(secretsPath)).toEqual(oldSecrets)
    expect(readFileSync(settingsPath)).toEqual(oldSettings)
    expect(changed).not.toHaveBeenCalled()
  })

  it('restores removed provider credentials and bindings when settings saving fails', () => {
    const { settingsPath, secretsPath, secure, config } = setup()
    const before = config.getSafe()
    const oldSecrets = readFileSync(secretsPath)
    disk.failRename = settingsPath

    expect(() => config.removeProvider('one')).toThrow('test disk rename failure')
    expect(config.getSafe()).toEqual(before)
    expect(secure.get(secretKeys.providerApiKey('one'))).toBe('test-old-one')
    expect(readFileSync(secretsPath)).toEqual(oldSecrets)
    expect(new ConfigService(settingsPath, new SecureStore(secretsPath)).getSafe()).toEqual(before)
  })

  it.each(['encrypt', 'write', 'rename'] as const)('keeps all credentials unchanged on batch %s failure', (operation) => {
    const { settingsPath, secretsPath, secure, config } = setup()
    const oldSettings = readFileSync(settingsPath)
    const oldSecrets = readFileSync(secretsPath)
    const before = config.getSafe()
    if (operation === 'encrypt') encryption.failAt = encryption.calls + 2
    if (operation === 'write') disk.failWrite = `${secretsPath}.tmp`
    if (operation === 'rename') disk.failRename = secretsPath

    expect(() => config.update({
      providers: [provider('one', 'test-new-one'), provider('three', 'test-new-three')],
      sync: { secret: 'test-new-sync', passphrase: 'test-new-passphrase' }
    })).toThrow()
    expect(config.getSafe()).toEqual(before)
    expect(secure.get(secretKeys.providerApiKey('one'))).toBe('test-old-one')
    expect(secure.get(secretKeys.providerApiKey('two'))).toBe('test-old-two')
    expect(secure.get(secretKeys.providerApiKey('three'))).toBe('')
    expect(secure.get(secretKeys.syncSecret())).toBe('')
    expect(readFileSync(secretsPath)).toEqual(oldSecrets)
    expect(readFileSync(settingsPath)).toEqual(oldSettings)
  })

  it.each(['delete', 'prefix'] as const)('keeps the cache and file unchanged on direct %s failure', (operation) => {
    const path = join(folder, 'secrets.dat')
    const secure = new SecureStore(path)
    secure.updateBatch({ 'provider.one.apiKey': 'test-one', 'provider.one.other': 'test-other' })
    const before = readFileSync(path)
    disk.failRename = path
    expect(() => operation === 'delete'
      ? secure.delete('provider.one.apiKey')
      : secure.deleteByPrefix('provider.one.')).toThrow('test disk rename failure')
    expect(secure.get('provider.one.apiKey')).toBe('test-one')
    expect(secure.get('provider.one.other')).toBe('test-other')
    expect(readFileSync(path)).toEqual(before)
  })

  it('removes a newly created credentials file when the first settings save fails', () => {
    const secretsPath = join(folder, 'new-secrets.dat')
    const settingsPath = join(folder, 'new-settings.json')
    const secure = new SecureStore(secretsPath)
    const config = new ConfigService(settingsPath, secure)
    disk.failRename = settingsPath
    expect(() => config.upsertProvider(provider('one', 'test-new-one'))).toThrow()
    expect(existsSync(secretsPath)).toBe(false)
    expect(existsSync(settingsPath)).toBe(false)
    expect(secure.get(secretKeys.providerApiKey('one'))).toBe('')
    expect(config.getSafe().providers).toEqual([])
  })

  it('deletes obsolete provider secrets after success and preserves unrelated credentials', () => {
    const { settingsPath, secretsPath, secure, config } = setup()
    const changed = vi.fn()
    config.on('changed', changed)
    config.removeProvider('one')
    expect(config.getRaw().featureBindings.termBrief).toBeUndefined()
    expect(secure.get(secretKeys.providerApiKey('one'))).toBe('')
    expect(secure.get(secretKeys.providerApiKey('two'))).toBe('test-old-two')
    expect(secure.get(secretKeys.developerPassphraseHash())).toBe('test-developer-hash')
    const reopened = new ConfigService(settingsPath, new SecureStore(secretsPath))
    expect(reopened.getSafe()).toEqual(config.getSafe())
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('reports a failed rollback instead of claiming the previous credentials were restored', () => {
    const { secure, secretsPath } = setup()
    expect(() => secure.updateBatch({ 'provider.one.apiKey': 'test-new-one' }, [], () => {
      disk.failWrite = `${secretsPath}.tmp`
      throw new Error('test settings failure')
    })).toThrow('原凭据恢复也失败')
    expect(secure.get(secretKeys.providerApiKey('one'))).toBe('test-old-one')
    expect(new SecureStore(secretsPath).get(secretKeys.providerApiKey('one'))).toBe('test-new-one')
  })
})
