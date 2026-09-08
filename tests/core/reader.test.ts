import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteRepository } from '../../src/main/data/sqlite-repository'
import { TermService } from '../../src/main/terms/term-service'
import { createDefaultSettings } from '../../src/shared/config/schema'
import type { ChatProvider, ProviderConfig } from '../../src/shared/types/provider'
import type { Term } from '../../src/shared/types/term'

vi.mock('electron', () => ({ app: { getPath: () => '.' } }))

let folder: string
let repo: SqliteRepository
const settings = createDefaultSettings()
const provider: ProviderConfig = { id: 'test', name: 'test', protocol: 'openai', baseUrl: 'https://example.test/v1', apiKey: '', model: 'mock', timeoutMs: 1000, maxRetries: 0 }
const unknown: Term = { id: 'unknown', surface: '测试词条', canonical: '测试词条', domain: 'general', range: [0, 4], confidence: 1, source: 'llm' }

function service(chat?: ChatProvider['chat']): TermService {
  return new TermService(repo, { getRaw: () => settings, resolveProviderFor: () => chat ? provider : undefined }, () => ({ id: 'test', protocol: 'openai', chat: chat!, test: async () => ({ ok: true }) }))
}

beforeEach(async () => {
  mkdirSync(join(process.cwd(), 'qa'), { recursive: true })
  folder = mkdtempSync(join(process.cwd(), 'qa', 'reader-test-'))
  repo = new SqliteRepository(join(folder, 'reader.db'))
  await repo.init()
  settings.term = createDefaultSettings().term
})
afterEach(() => { repo.close(); rmSync(folder, { recursive: true, force: true }) })

describe('reader and terminology workflows', () => {
  it('defaults speed mode to three bounded workers', () => {
    expect(settings.term.speedMode).toBe(true)
    expect(settings.term.speedConcurrency).toBe(3)
  })

  it('keeps repeated occurrences, favors the longest term and respects English boundaries', async () => {
    const result = await service().detect('API Key 与 API。mail 不是 AI。机器学习，机器学习。')
    expect(result.terms.map((term) => term.surface)).toEqual(['API Key', 'API', 'AI', '机器学习', '机器学习'])
    expect(result.terms.every((term) => term.range[1] > term.range[0])).toBe(true)
  })

  it('honors disabled domains, ignored terms and disabled local detection', async () => {
    settings.term.enabledDomains = ['economics']
    expect((await service().detect('机器学习与回测')).terms.map((term) => term.canonical)).toEqual(['回测'])
    settings.term.ignoredTerms = ['回测']
    expect((await service().detect('回测')).terms).toEqual([])
    settings.term.enabled = false
    expect((await service().detect('风险')).terms).toEqual([])
  })

  it('rejects oversized documents and uses the lexicon without any model', async () => {
    await expect(service().detect('x'.repeat(100001))).rejects.toThrow()
    const term = (await service().detect('机器学习')).terms[0]
    const result = await service().open({ term })
    expect(result.explanation.source).toBe('lexicon')
    expect(result.thread.path[0].canonical).toBe('机器学习')
  })

  it('validates AI output against actual source text and retains local results on failure', async () => {
    const model = service(async function* () { yield { type: 'delta', text: '{"terms":[{"surface":"不存在的词","canonical":"错词","domain":"general"}]}' } })
    expect((await model.detect('机器学习', true)).terms.map((term) => term.canonical)).toEqual(['机器学习'])
    const failed = service(async function* () { yield { type: 'error', error: 'internal sensitive failure' } })
    const result = await failed.detect('机器学习', true)
    expect(result.terms).toHaveLength(1)
    expect(result.warning).toBeTruthy()
    expect(result.warning).not.toContain('sensitive')
  })

  it('explains a whole selection with term breakdown and prior concept context', async () => {
    const model = service(async function* () {
      yield { type: 'delta', text: JSON.stringify({ summary: '这段话说明两个概念的关系。', termExplanations: [{ surface: '机器学习', explanation: '从数据中学习规律。' }], context: '它与上一轮概念形成递进关系。' }) }
    })
    const result = await model.explainSelection('机器学习与回测', ['机会成本'])
    expect(result.summary).toContain('两个概念')
    expect(result.termExplanations[0].surface).toBe('机器学习')
    expect(result.context).toContain('递进')
  })

  it('caches a valid model explanation and recovers it after database reopen without a model', async () => {
    const model = service(async function* () { yield { type: 'delta', text: JSON.stringify({ brief: '测试解释', definition: '一个用于测试的概念', related: ['概念'] }) } })
    expect((await model.explain(unknown)).source).toBe('llm')
    repo.close()
    repo = new SqliteRepository(join(folder, 'reader.db'))
    await repo.init()
    expect((await service().explain(unknown)).source).toBe('cache')
  })

  it('does not cache malformed or empty model explanations', async () => {
    const model = service(async function* () { yield { type: 'delta', text: '{"brief":null}' } })
    await expect(model.explain(unknown)).rejects.toThrow('格式')
    expect(await repo.getExplanation(unknown.canonical, unknown.domain, 'intermediate')).toBeUndefined()
    await expect(service(async function* () { yield { type: 'done' } }).explain(unknown)).rejects.toThrow('AI 请求失败')
  })

  it('retains five levels of concept history and parent relationships after reopening', async () => {
    let parentThreadId: string | undefined
    for (const name of ['术语', '概念', '定义', '逻辑', '推理']) {
      const term = (await service().detect(name)).terms[0]
      const opened = await service().open({ term, parentThreadId })
      parentThreadId = opened.thread.threadId
    }
    repo.close()
    repo = new SqliteRepository(join(folder, 'reader.db'))
    await repo.init()
    const last = await repo.getThread(parentThreadId!)
    expect(last?.path.map((term) => term.canonical)).toEqual(['术语', '概念', '定义', '逻辑', '推理'])
    expect(last?.parentThreadId).toBeTruthy()
    expect(await repo.listThreads()).toHaveLength(5)
  })

  it('enforces the configured concept nesting limit', async () => {
    settings.term.maxNestedDepth = 2
    const firstTerm = (await service().detect('机器学习')).terms[0]
    const first = await service().open({ term: firstTerm })
    const secondTerm = (await service().detect('回测')).terms[0]
    const second = await service().open({ term: secondTerm, parentThreadId: first.thread.threadId })
    const thirdTerm = { ...firstTerm, id: 'third' }
    await expect(service().open({ term: thirdTerm, parentThreadId: second.thread.threadId })).rejects.toThrow('嵌套上限')
  })

  it('saves a question before a failing model call and never stores an invented answer', async () => {
    const model = service()
    const term = (await model.detect('概念')).terms[0]
    const opened = await model.open({ term })
    await expect(model.followup(opened.thread.threadId, '可以举例吗？')).rejects.toThrow('设置')
    const saved = await repo.getThread(opened.thread.threadId)
    expect(saved?.messages).toHaveLength(1)
    expect(saved?.messages[0].role).toBe('user')
  })

  it('persists questions and answers and rejects concurrent submissions to the same thread', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const model = service(async function* () { await gate; yield { type: 'delta', text: '示例回答' } })
    const term = (await model.detect('概念')).terms[0]
    const opened = await model.open({ term })
    const first = model.followup(opened.thread.threadId, '举例')
    await expect(model.followup(opened.thread.threadId, '第二个问题')).rejects.toThrow('仍在生成')
    release()
    expect((await first).messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect((await repo.getThread(opened.thread.threadId))?.messages.at(-1)?.content).toBe('示例回答')
  })

  it('preserves documents and custom terms across restarts and deletes only the requested document', async () => {
    await repo.putReaderDocument({ id: 'a', title: '原文', text: '自定义条目', createdAt: 1, updatedAt: 2 })
    await repo.putReaderDocument({ id: 'b', title: '另一份', text: '保留', createdAt: 1, updatedAt: 3 })
    await repo.putCustomTerm({ canonical: '自定义条目', aliases: [], domain: 'custom', brief: '我的定义', createdAt: 1 })
    const term = (await service().detect('自定义条目')).terms[0]
    expect((await service().explain(term)).brief).toBe('我的定义')
    repo.close()
    repo = new SqliteRepository(join(folder, 'reader.db'))
    await repo.init()
    expect((await repo.listReaderDocuments())[1].text).toBe('自定义条目')
    await repo.deleteReaderDocument('a')
    expect((await repo.listReaderDocuments()).map((document) => document.id)).toEqual(['b'])
  })
})
