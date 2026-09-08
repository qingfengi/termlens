import type { TermLensApi } from '@shared/ipc/api'

export function api(): TermLensApi {
  if (!window.termlens) throw new Error('无法连接桌面服务，请重新打开 TermLens。')
  return window.termlens
}

export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : '操作未完成，请重试。'
}

export function dateText(time: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(time)
}

export function Notice({ error, children }: { error?: boolean; children: React.ReactNode }): JSX.Element {
  return <div className={`notice${error ? ' notice-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>
}
