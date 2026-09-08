import { app } from 'electron'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import sqlite from 'node-sqlite3-wasm'
import type { Database } from 'node-sqlite3-wasm'
import { MIGRATIONS, LATEST_VERSION } from './migrations'

/**
 * 打开数据库并执行迁移（任务 T0.10）
 * node-sqlite3-wasm 为同步 API，直接调用。
 */
export function openDatabase(dbPath?: string): Database {
  const path = dbPath ?? join(app.getPath('userData'), 'termlens.db')

  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const db = new sqlite.Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')

  const userVersion = (db.get('PRAGMA user_version') as Record<string, number> | null)
    ?.user_version ?? 0

  if (userVersion > LATEST_VERSION) {
    db.close()
    throw new Error('数据库来自较新版本，请使用相应版本打开。')
  }

  db.exec('BEGIN')
  try {
    for (const migration of MIGRATIONS) {
      if (migration.version > userVersion) db.exec(migration.sql)
    }
    db.exec(`PRAGMA user_version = ${LATEST_VERSION}`)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    db.close()
    throw err
  }

  return db
}
