import { Worker } from 'node:worker_threads'
import type { ExtractedSource, SourceRequest } from '../../shared/types/source'

export async function extractSource(request: SourceRequest, signal: AbortSignal, onProgress: (message: string) => void): Promise<ExtractedSource> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./extract-worker.js', import.meta.url), {
      workerData: request,
      resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 }
    })
    let finished = false
    const settle = (error?: Error, result?: ExtractedSource): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      void worker.terminate()
      if (error) reject(error)
      else resolve(result!)
    }
    const cancel = (): void => settle(new Error('读取已取消。'))
    const timer = setTimeout(() => settle(new Error('解析超过 90 秒上限，已停止。请拆分文件后重试。')), 90000)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) { cancel(); return }
    worker.on('message', (message: { type: string; message?: string; result?: ExtractedSource }) => {
      if (message.type === 'progress') onProgress(message.message ?? '正在提取文字…')
      else if (message.type === 'complete' && message.result) settle(undefined, message.result)
      else if (message.type === 'error') settle(new Error(message.message ?? '文字读取失败。'))
    })
    worker.on('error', () => settle(new Error('文字解析进程无法运行或内存不足。请重试或拆分文件。')))
    worker.on('exit', () => { if (!finished) settle(new Error('文字解析进程提前退出，请重新读取。')) })
  })
}
