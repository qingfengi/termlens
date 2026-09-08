import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppKernel } from './app-kernel'
import { PUBLIC_CHANNELS } from '@shared/ipc/channels'
import { appSettingsSchema, providerConfigSchema, providerModelsRequestSchema } from '@shared/config/schema'
import { createChatProvider, listProviderModels } from '@shared/providers'
import { termSchema } from '../terms/term-service'

const idSchema = z.string().min(1).max(160)
const levelSchema = z.enum(['beginner', 'intermediate', 'expert'])

export function registerIpc(kernel: AppKernel): void {
  const { config, repo, terms, windows } = kernel
  function handle<S extends z.ZodTypeAny>(name: keyof typeof PUBLIC_CHANNELS, schema: S, action: (input: z.output<S>) => unknown): void {
    ipcMain.handle(PUBLIC_CHANNELS[name], async (event, input: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || !windows.owns(window) || event.senderFrame !== event.sender.mainFrame) throw new Error('无效的请求来源。')
      const parsed = schema.safeParse(input)
      if (!parsed.success) throw new Error('输入格式不正确或超出允许长度。')
      try { return await action(parsed.data) } catch (error) {
        let message = error instanceof Error ? error.message : '操作失败，请重试。'
        if (typeof parsed.data?.apiKey === 'string' && parsed.data.apiKey) message = message.split(parsed.data.apiKey).join('[已隐藏]')
        for (const provider of config.getRaw().providers) if (provider.apiKey) message = message.split(provider.apiKey).join('[已隐藏]')
        throw new Error(message.slice(0, 1200))
      }
    })
  }
  handle('configGet', z.undefined(), () => config.getSafe())
  handle('configUpdate', appSettingsSchema.pick({ appearance: true, providers: true, featureBindings: true, term: true }).deepPartial().strict(), (patch) => config.update(patch as Parameters<typeof config.update>[0]))
  handle('providerList', z.undefined(), () => config.getSafe().providers)
  handle('providerUpsert', providerConfigSchema, (provider) => config.upsertProvider(provider))
  handle('providerRemove', idSchema, (id) => config.removeProvider(id))
  handle('providerModels', providerModelsRequestSchema, (input) => listProviderModels({ ...input, apiKey: config.resolveProviderApiKey(input) }))
  handle('providerTest', idSchema, async (id) => {
    const provider = config.getProvider(id)
    if (!provider) return { ok: false, error: '请先保存服务配置。' }
    const result = await createChatProvider(provider).test()
    return result.ok ? result : { ok: false, latencyMs: result.latencyMs, error: '连接失败，请检查地址、模型、余额和密钥。' }
  })
  handle('termDetect', z.object({ text: z.string().max(100000), useAi: z.boolean().optional() }), ({ text, useAi }) => terms.detect(text, useAi))
  handle('termBrief', termSchema, (term) => terms.explain(term))
  handle('termDetail', z.object({ term: termSchema, parentThreadId: idSchema.optional(), threadId: idSchema.optional(), level: levelSchema.optional() }), (request) => terms.open(request))
  handle('termFollowup', z.object({ threadId: idSchema, question: z.string().trim().min(1).max(4000) }), ({ threadId, question }) => terms.followup(threadId, question))
  handle('termThread', idSchema, (id) => repo.getThread(id))
  handle('termHistory', z.undefined(), () => repo.listThreads())
  handle('termCustomUpsert', z.object({ canonical: z.string().trim().min(1).max(100), domain: z.string().min(1).max(80), brief: z.string().trim().min(1).max(4000), detail: z.string().max(12000).optional(), aliases: z.array(z.string().min(1).max(100)).max(20) }), (entry) => repo.putCustomTerm({ ...entry, createdAt: Date.now() }))
  handle('readerList', z.undefined(), () => repo.listReaderDocuments())
  handle('readerSave', z.object({ id: idSchema.optional(), title: z.string().trim().min(1).max(200), text: z.string().max(100000) }), async (input) => {
    const previous = input.id ? (await repo.listReaderDocuments()).find((item) => item.id === input.id) : undefined
    if (input.id && !previous) throw new Error('阅读记录不存在，请新建一份记录。')
    const document = { ...input, id: input.id ?? `doc_${randomUUID()}`, createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now() }
    await repo.putReaderDocument(document)
    return document
  })
  handle('readerDelete', idSchema, (id) => repo.deleteReaderDocument(id))
  handle('selectionGet', z.undefined(), () => kernel.selection.snapshot)
  handle('selectionConfigure', z.object({ automatic: z.boolean() }), ({ automatic }) => {
    config.update({ term: { selectionAuto: automatic } })
    kernel.selection.configure(automatic)
  })
  handle('selectionOpenManager', z.undefined(), () => { windows.showMainWindow(); windows.hideQuickWindow() })
  handle('selectionHide', z.undefined(), () => windows.hideQuickWindow())
  handle('windowMinimize', z.undefined(), () => windows.getMainWindow()?.minimize())
  handle('windowClose', z.undefined(), () => windows.getMainWindow()?.close())
}
