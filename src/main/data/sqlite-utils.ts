/**
 * node-sqlite3-wasm 的 .d.ts 与运行时行为有两个偏差，集中在此声明后统一转换：
 * 1. `true/false` 会被存为 1/0，读出是 number；
 * 2. bigint 列读出为 number（JS 安全整数范围内）。
 * 本层负责把行数据还原成领域类型，上层不接触这些细节。
 */

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SqliteRow {
  [column: string]: string | number | null | Uint8Array | bigint | object
}

export interface SqliteDatabaseLike {
  run(sql: string, values?: Record<string, unknown> | unknown[]): unknown
  get(sql: string, values?: Record<string, unknown> | unknown[]): SqliteRow | null
  all(sql: string, values?: Record<string, unknown> | unknown[]): SqliteRow[]
  exec(sql: string): void
  close(): void
}

export function toInt(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0
  return 0
}

export function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

export function parseJsonArray<T>(value: unknown): T[] {
  const text = toText(value)
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

export function parseJsonObject<T>(value: unknown): T | undefined {
  const text = toText(value)
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}
