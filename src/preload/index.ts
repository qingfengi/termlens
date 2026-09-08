/**
 * 预加载脚本（T0.6）
 * 在 contextIsolation 下安全暴露给渲染进程的最小 API 面。
 * 安全策略：任何 channel 不在白名单列表里就拒绝，且只允许调用近一次声明的事件。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { PUBLIC_CHANNELS } from '../shared/ipc/channels'
import type { TermLensApi } from '../shared/ipc/api'

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke(channel, ...args)
}

const invokeMap = <T extends Record<string, string>>(map: T) =>
  Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, (...args: unknown[]) => invoke(v, ...args)])
  ) as { [K in keyof T]: (...args: unknown[]) => Promise<unknown> }

const enabled: Array<keyof TermLensApi> = [
  'sourcePickFile', 'sourceImport', 'sourceStatus', 'sourcePause', 'sourceCancel', 'sourceList', 'sourceGet', 'sourceDelete', 'sourceAnalyze', 'sourceAsk', 'sourceOpenLocation', 'sourceOpenReader',
  'configGet', 'configUpdate', 'providerList', 'providerUpsert', 'providerRemove', 'providerTest', 'providerModels',
  'termDetect', 'termBrief', 'termDetail', 'termFollowup', 'termThread', 'termHistory', 'termCustomUpsert',
  'readerList', 'readerSave', 'readerDelete', 'windowMinimize', 'windowClose',
  'selectionGet', 'selectionConfigure', 'selectionOpenManager', 'selectionHide'
]
contextBridge.exposeInMainWorld('termlens', invokeMap(Object.fromEntries(enabled.map((name) => [name, PUBLIC_CHANNELS[name]]))))
