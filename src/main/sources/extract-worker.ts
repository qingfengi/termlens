import { parentPort, workerData } from 'node:worker_threads'
import type { SourceRequest } from '../../shared/types/source'
import { extractSourceCore } from './extract-source-core'

const send = (message: unknown): void => { parentPort?.postMessage(message) }
try {
  const result = await extractSourceCore(workerData as SourceRequest, new AbortController().signal,
    (message) => send({ type: 'progress', message }))
  send({ type: 'complete', result })
} catch (error) {
  // Known parser errors are written by us; raw filesystem and network diagnostics stay private.
  const message = error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : '读取失败：文件内容损坏或格式暂不支持。'
  send({ type: 'error', message })
}
parentPort?.close()
