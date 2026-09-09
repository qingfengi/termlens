import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SourceService, selectExcerpts } from '../../src/main/sources/source-service'
import { SqliteRepository } from '../../src/main/data/sqlite-repository'
import type { ChatProvider, ProviderConfig } from '../../src/shared/types/provider'
import type { ExtractedSource, SourceDocument, SourceTask } from '../../src/shared/types/source'
import type { Term } from '../../src/shared/types/term'
vi.mock('electron', () => ({ app: { getPath: () => '.' } }))

let directory: string
let repo: SqliteRepository
let services: SourceService[]
const extracted: ExtractedSource = { title: '资料', kind: 'file', location: 'D:/fixture.txt', format: 'txt', coverage: 'complete', coverageNote: '文本已提取', warnings: [], segments: [{ id: 'p1', label: '段落1', text: '机器学习需要样本。' }, { id: 'p2', label: '段落2', text: '差分隐私限制单条数据的影响。' }] }
const provider: ProviderConfig = { id: 'test', name: 'test', model: 'mock', protocol: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key', timeoutMs: 1000, maxRetries: 0 }

function service(options: { extract?: () => Promise<ExtractedSource>; chat?: ChatProvider['chat']; detect?: (text: string, useAi?: boolean, includeTokens?: boolean) => Promise<{ terms: Term[]; warning?: string }> } = {}): SourceService {
  const instance = new SourceService(repo, { resolveProviderFor: () => provider }, { detect: options.detect ?? (async () => ({ terms: [] })) }, options.extract ?? (async () => structuredClone(extracted)), () => ({ id: 'test', protocol: 'openai', chat: options.chat ?? (async function* () { yield { type: 'delta', text: '{"answer":"根据原文，单条数据影响有限。[p2]","citationIds":["p2"]}' } }), test: async () => ({ ok: true }) }))
  services.push(instance)
  return instance
}
async function finished(instance: SourceService, task: SourceTask): Promise<SourceTask> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = instance.status().tasks.find((item) => item.id === task.id)!
    if (!['queued', 'running'].includes(status.state)) return status
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('job did not finish')
}
async function imported(instance: SourceService): Promise<SourceDocument> {
  const result = await finished(instance, instance.import({ kind: 'file', location: 'D:/fixture.txt' }))
  expect(result.state).toBe('complete')
  return (await repo.getSource(result.sourceId!))!
}
beforeEach(async () => {
  mkdirSync(join(process.cwd(), 'qa'), { recursive: true })
  directory = mkdtempSync(join(process.cwd(), 'qa/source-service-'))
  repo = new SqliteRepository(join(directory, 'source.db'))
  await repo.init()
  services = []
})
afterEach(() => { for (const instance of services) instance.dispose(); repo.close(); rmSync(directory, { recursive: true, force: true }) })

describe('background source lifecycle', () => {
  it('imports, preserves prior reader data and restores source documents after restart', async () => {
    await repo.putReaderDocument({ id: 'old', title: '旧记录', text: '原文', createdAt: 1, updatedAt: 1 })
    const source = await imported(service())
    repo.close()
    await repo.init()
    expect((await repo.getSource(source.id))?.segments).toEqual(extracted.segments)
    expect((await repo.listReaderDocuments())[0].id).toBe('old')
    expect((await repo.listSources())[0].segmentCount).toBe(2)
    await repo.deleteSource(source.id)
    expect(await repo.getSource(source.id)).toBeUndefined()
  })
  it('pauses queued reads and cancels late active results without persisting them', async () => {
    let resolve!: (value: ExtractedSource) => void
    const extract = vi.fn(() => new Promise<ExtractedSource>((done) => { resolve = done }))
    const instance = service({ extract })
    instance.pause(true)
    const task = instance.import({ kind: 'file', location: 'D:/fixture.txt' })
    await new Promise<void>((done) => setImmediate(done))
    expect(extract).not.toHaveBeenCalled()
    instance.pause(false)
    expect(extract).toHaveBeenCalledOnce()
    instance.pause(true)
    resolve(structuredClone(extracted))
    await new Promise<void>((done) => setImmediate(done))
    expect((await finished(instance, task)).state).toBe('cancelled')
    expect(await repo.listSources()).toEqual([])
  })
  it('limits pending jobs and refuses deleting a document with queued work', async () => {
    const instance = service()
    const source = await imported(instance)
    instance.pause(true)
    await instance.analyze(source.id, false)
    await expect(instance.delete(source.id)).rejects.toThrow('停止')
    for (let i = 0; i < 9; i++) instance.import({ kind: 'file', location: 'D:/fixture.txt' })
    expect(() => instance.import({ kind: 'file', location: 'D:/fixture.txt' })).toThrow('较多')
    for (const task of instance.status().tasks) instance.cancel(task.id)
    await instance.delete(source.id)
  })
  it('retains partial AI analysis and does not resend or erase completed segment terms', async () => {
    let calls = 0
    const instance = service({ chat: async function* () {
      calls++
      if (calls === 2) { yield { type: 'error', error: 'private-upstream-detail' }; return }
      yield { type: 'delta', text: calls === 1 ? '{"terms":["机器学习","不存在"]}' : '{"terms":["差分隐私"]}' }
    } })
    const source = await imported(instance)
    expect((await finished(instance, await instance.analyze(source.id, true))).state).toBe('failed')
    expect((await repo.getSource(source.id))?.analysis).toBe('partial')
    expect((await repo.getSource(source.id))?.segments[0].terms?.map((term) => term.surface)).toEqual(['机器学习'])
    expect((await finished(instance, await instance.analyze(source.id, true))).state).toBe('complete')
    expect(calls).toBe(3)
    expect((await repo.getSource(source.id))?.segments[0].terms?.[0].surface).toBe('机器学习')
    expect((await repo.getSource(source.id))?.analysis).toBe('complete')
  })
  it('grounds answers in actual excerpts and persists questions and references', async () => {
    const instance = service()
    const source = await imported(instance)
    const task = await instance.ask({ id: source.id, question: '差分隐私是什么？', segmentId: 'p2' })
    expect((await finished(instance, task)).state).toBe('complete')
    const saved = (await repo.getSource(source.id))!
    expect(saved.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(saved.messages[1].citations).toEqual([{ segmentId: 'p2', label: '段落2' }])
    await expect(instance.ask({ id: source.id, question: '解释', segmentId: 'missing' })).rejects.toThrow('位置不存在')
  })
  it('rejects invented citations and retains the question with failure state', async () => {
    const instance = service({ chat: async function* () { yield { type: 'delta', text: '{"answer":"伪造的回答","citationIds":["not-provided"]}' } } })
    const source = await imported(instance)
    expect((await finished(instance, await instance.ask({ id: source.id, question: '测试' }))).state).toBe('failed')
    const saved = (await repo.getSource(source.id))!
    expect(saved.messages).toHaveLength(1)
    expect(saved.messages[0].error).toContain('未完成')
  })
  it('does not leak upstream errors and local analysis does not pretend AI analysis', async () => {
    const instance = service({ chat: async function* () { yield { type: 'error', error: provider.apiKey } } })
    const source = await imported(instance)
    await finished(instance, await instance.analyze(source.id, false))
    expect((await repo.getSource(source.id))?.analysis).toBe('none')
    const failed = await finished(instance, await instance.ask({ id: source.id, question: '测试' }))
    expect(failed.error).not.toContain(provider.apiKey)
  })

  it('persists visible warnings when token or display limits are reached', async () => {
    const token: Term = { id: 'token', surface: '上溢', canonical: '上溢', domain: 'general', range: [0, 2], confidence: 1, source: 'token' }
    const instance = service({ detect: async () => ({ terms: Array.from({ length: 101 }, (_, index) => ({ ...token, id: `token-${index}`, surface: `词${index}`, canonical: `词${index}`, range: [index * 2, index * 2 + 2] as [number, number] })), warning: '基础分词结果较多，当前最多展示 1000 个可点击词语。' }) })
    const source = await imported(instance)
    expect((await finished(instance, await instance.analyze(source.id, false))).state).toBe('complete')
    expect((await repo.getSource(source.id))?.warnings.join(' ')).toContain('基础分词提示')
    expect((await repo.getSource(source.id))?.warnings.join(' ')).toContain('术语标注上限')
  })
})

it('retrieves matching later passages while preserving selected location and bounded context', () => {
  const segments = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, label: `第${i}段`, text: i === 18 ? '差分隐私'.repeat(3000) : '普通文字'.repeat(3000) }))
  const result = selectExcerpts(segments, '差分隐私', 'p19')
  expect(result[0].id).toBe('p19')
  expect(result.some((item) => item.id === 'p18')).toBe(true)
  expect(result.length).toBeLessThanOrEqual(6)
  expect(result.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(12000)
})
