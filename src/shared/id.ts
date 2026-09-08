/**
 * ID 生成器。位于 shared/，必须同时兼容 Node 主进程与浏览器渲染进程（NFR-9），
 * 因此用 Web Crypto 的 crypto.randomUUID() 而非 node:crypto。
 */
const uuid = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  // 老环境兜底：RFC4122 v4 手工拼装
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** 统一前缀便于日志排查与库内全文本检索 */
export const genId = {
  transcript: (): string => `tr_${uuid()}`,
  thread: (): string => `th_${uuid()}`,
  message: (): string => `msg_${uuid()}`,
  study: (): string => `st_${uuid()}`,
  recording: (): string => `rec_${uuid()}`,
  solve: (): string => `sv_${uuid()}`,
  usage: (): string => `usg_${uuid()}`,
  provider: (): string => `pv_${uuid()}`,
  term: (): string => `tm_${uuid()}`
}
