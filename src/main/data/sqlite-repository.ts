import type { ConceptThread, Explanation, ExplanationLevel, Term, ThreadMessage } from '@shared/types/term'
import type { ReaderDocument } from '@shared/ipc/api'
import type {
  CachedExplanation,
  CustomTerm,
  RecordingRecord,
  Repository,
  SolveRecord,
  StudyItem,
  TranscriptRecord,
  UsageRecord
} from './repository'
import { explanationCacheKey } from './repository'
import { openDatabase } from './db'
import type { SqliteDatabaseLike } from './sqlite-utils'
import {
  parseJsonArray,
  parseJsonObject,
  toInt,
  toText
} from './sqlite-utils'

/**
 * SQLite 仓储本地实现（任务 T0.10）
 * node-sqlite3-wasm 为同步 API，但 Repository 是 async 接口——
 * 这里包装成 Promise 形式，与跨进程/远程实现保持一致。
 */
export class SqliteRepository implements Repository {
  private db: SqliteDatabaseLike | null = null
  private readonly dbPath?: string

  constructor(dbPath?: string) {
    this.dbPath = dbPath
  }

  async init(): Promise<void> {
    this.db = openDatabase(this.dbPath) as unknown as SqliteDatabaseLike
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private ensureOpen(): SqliteDatabaseLike {
    if (!this.db) throw new Error('Repository not initialized. Call init() first.')
    return this.db
  }

  private ts(): number {
    return Date.now()
  }

  private keyFor(canonical: string, domain: string, level: ExplanationLevel): string {
    return explanationCacheKey(canonical, domain, level)
  }

  // ==================== 术语解释缓存 ====================

  async getExplanation(
    canonical: string,
    domain: string,
    level: ExplanationLevel
  ): Promise<CachedExplanation | undefined> {
    const db = this.ensureOpen()
    const row = db.get(
      `SELECT cache_key, canonical, domain, level, brief, detail_json, sub_terms_json, source, updated_at
       FROM explanations WHERE cache_key = ?`,
      [this.keyFor(canonical, domain, level)]
    )
    if (!row) return undefined
    const detail = parseJsonObject<CachedExplanation['detail']>(row.detail_json)
    return {
      cacheKey: row.cache_key as string,
      termId: '', // 外键索引，懒加载时不必回填
      canonical: toText(row.canonical),
      domain: toText(row.domain),
      level: toText(row.level) as ExplanationLevel,
      brief: toText(row.brief),
      detail,
      subTerms: parseJsonArray<Term>(row.sub_terms_json),
      source: toText(row.source) as CachedExplanation['source'],
      updatedAt: toInt(row.updated_at)
    }
  }

  async putExplanation(explanation: Explanation): Promise<void> {
    const db = this.ensureOpen()
    db.run(
      `INSERT INTO explanations (cache_key, canonical, domain, level, brief, detail_json, sub_terms_json, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         brief = excluded.brief,
         detail_json = excluded.detail_json,
         sub_terms_json = excluded.sub_terms_json,
         source = excluded.source,
         updated_at = excluded.updated_at`,
      [
        this.keyFor(explanation.canonical, explanation.domain, explanation.level),
        explanation.canonical,
        explanation.domain,
        explanation.level,
        explanation.brief,
        JSON.stringify(explanation.detail ?? null),
        JSON.stringify(explanation.subTerms ?? []),
        explanation.source,
        Date.now()
      ]
    )
  }

  // ==================== 自定义术语 ====================

  async listCustomTerms(): Promise<CustomTerm[]> {
    const db = this.ensureOpen()
    const rows = db.all(`SELECT canonical, aliases_json, domain, brief, detail, created_at FROM custom_terms ORDER BY created_at DESC`)
    return rows.map((r) => ({
      canonical: toText(r.canonical),
      aliases: parseJsonArray<string>(r.aliases_json),
      domain: toText(r.domain),
      brief: toText(r.brief),
      detail: r.detail === null ? undefined : toText(r.detail),
      createdAt: toInt(r.created_at)
    }))
  }

  async putCustomTerm(term: CustomTerm): Promise<void> {
    const db = this.ensureOpen()
    db.run(
      `INSERT INTO custom_terms (canonical, aliases_json, domain, brief, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical) DO UPDATE SET
         aliases_json = excluded.aliases_json,
         domain = excluded.domain,
         brief = excluded.brief,
         detail = excluded.detail`,
      [
        term.canonical,
        JSON.stringify(term.aliases ?? []),
        term.domain,
        term.brief,
        term.detail ?? null,
        term.createdAt ?? this.ts()
      ]
    )
  }

  async deleteCustomTerm(canonical: string): Promise<void> {
    const db = this.ensureOpen()
    db.run(`DELETE FROM custom_terms WHERE canonical = ?`, [canonical])
  }

  // ==================== 概念会话线程 ====================

  async getThread(threadId: string): Promise<ConceptThread | undefined> {
    const db = this.ensureOpen()
    const row = db.get(
      `SELECT thread_id, parent_thread_id, path_json, created_at FROM threads WHERE thread_id = ?`,
      [threadId]
    )
    if (!row) return undefined
    return {
      threadId: toText(row.thread_id),
      parentThreadId:
        row.parent_thread_id === null ? undefined : toText(row.parent_thread_id),
      path: parseJsonArray(row.path_json),
      messages: await this.listMessages(threadId),
      createdAt: toInt(row.created_at)
    }
  }

  async putThread(thread: ConceptThread): Promise<void> {
    const db = this.ensureOpen()
    db.exec('BEGIN')
    try {
    db.run(
      `INSERT INTO threads (thread_id, parent_thread_id, path_json, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET parent_thread_id = excluded.parent_thread_id, path_json = excluded.path_json`,
      [thread.threadId, thread.parentThreadId ?? null, JSON.stringify(thread.path), thread.createdAt]
    )
    for (const m of thread.messages) {
      db.run(
        `INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content`,
        [m.id, thread.threadId, m.role, m.content, m.createdAt]
      )
    }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  async listChildThreads(parentThreadId: string): Promise<ConceptThread[]> {
    const db = this.ensureOpen()
    const rows = db.all(
      `SELECT thread_id, parent_thread_id, path_json, created_at FROM threads WHERE parent_thread_id = ? ORDER BY created_at ASC`,
      [parentThreadId]
    )
    const out: ConceptThread[] = []
    for (const r of rows) {
      out.push({
        threadId: toText(r.thread_id),
        parentThreadId: r.parent_thread_id === null ? undefined : toText(r.parent_thread_id),
        path: parseJsonArray(r.path_json),
        messages: await this.listMessages(toText(r.thread_id)),
        createdAt: toInt(r.created_at)
      })
    }
    return out
  }

  private async listMessages(threadId: string): Promise<ThreadMessage[]> {
    const db = this.ensureOpen()
    const rows = db.all(
      `SELECT id, role, content, created_at FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`,
      [threadId]
    )
    return rows.map((r) => ({
      id: toText(r.id),
      role: toText(r.role) as ThreadMessage['role'],
      content: toText(r.content),
      createdAt: toInt(r.created_at)
    }))
  }

  // ==================== 转写稿 ====================

  async listTranscripts(limit = 50): Promise<TranscriptRecord[]> {
    const db = this.ensureOpen()
    const rows = db.all(
      `SELECT id, title, raw_text, formatted_text, language, duration_ms, origin, created_at
       FROM transcripts ORDER BY created_at DESC LIMIT ?`,
      [limit]
    )
    return rows.map((r) => ({
      id: toText(r.id),
      title: toText(r.title),
      rawText: toText(r.raw_text),
      formattedText: r.formatted_text === null ? undefined : toText(r.formatted_text),
      language: toText(r.language),
      durationMs: toInt(r.duration_ms),
      origin: toText(r.origin) as TranscriptRecord['origin'],
      createdAt: toInt(r.created_at)
    }))
  }

  async getTranscript(id: string): Promise<TranscriptRecord | undefined> {
    const db = this.ensureOpen()
    const row = db.get(
      `SELECT id, title, raw_text, formatted_text, language, duration_ms, origin, created_at FROM transcripts WHERE id = ?`,
      [id]
    )
    if (!row) return undefined
    return {
      id: toText(row.id),
      title: toText(row.title),
      rawText: toText(row.raw_text),
      formattedText: row.formatted_text === null ? undefined : toText(row.formatted_text),
      language: toText(row.language),
      durationMs: toInt(row.duration_ms),
      origin: toText(row.origin) as TranscriptRecord['origin'],
      createdAt: toInt(row.created_at)
    }
  }

  async putTranscript(record: TranscriptRecord): Promise<void> {
    const db = this.ensureOpen()
    db.run(
      `INSERT INTO transcripts (id, title, raw_text, formatted_text, language, duration_ms, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, raw_text = excluded.raw_text, formatted_text = excluded.formatted_text,
         language = excluded.language, duration_ms = excluded.duration_ms, origin = excluded.origin`,
      [
        record.id,
        record.title,
        record.rawText,
        record.formattedText ?? null,
        record.language,
        record.durationMs,
        record.origin,
        record.createdAt
      ]
    )
  }

  async listThreads(): Promise<ConceptThread[]> {
    const rows = this.ensureOpen().all(`SELECT thread_id FROM threads ORDER BY created_at DESC, rowid DESC LIMIT 100`)
    const threads = await Promise.all(rows.map((row) => this.getThread(toText(row.thread_id))))
    return threads.filter((thread): thread is ConceptThread => Boolean(thread))
  }

  async listReaderDocuments(): Promise<ReaderDocument[]> {
    return this.ensureOpen().all(`SELECT * FROM reader_documents ORDER BY updated_at DESC LIMIT 100`)
      .map((row) => ({ id: toText(row.id), title: toText(row.title), text: toText(row.text), createdAt: toInt(row.created_at), updatedAt: toInt(row.updated_at) }))
  }

  async putReaderDocument(document: ReaderDocument): Promise<void> {
    this.ensureOpen().run(`INSERT INTO reader_documents (id,title,text,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,text=excluded.text,updated_at=excluded.updated_at`,
      [document.id, document.title, document.text, document.createdAt, document.updatedAt])
  }

  async deleteReaderDocument(id: string): Promise<void> {
    this.ensureOpen().run('DELETE FROM reader_documents WHERE id=?', [id])
  }

  async listStudyItems(limit = 50): Promise<StudyItem[]> {
    return this.ensureOpen().all('SELECT * FROM study_items ORDER BY created_at DESC LIMIT ?', [limit]).map((row) => ({
      id: toText(row.id), question: toText(row.question), explanation: toText(row.explanation), keyPoints: parseJsonArray<string>(row.key_points_json), subject: row.subject === null ? undefined : toText(row.subject), createdAt: toInt(row.created_at)
    }))
  }

  async putStudyItem(item: StudyItem): Promise<void> {
    this.ensureOpen().run(`INSERT INTO study_items (id,question,explanation,key_points_json,subject,created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET question=excluded.question,explanation=excluded.explanation,key_points_json=excluded.key_points_json,subject=excluded.subject`, [item.id,item.question,item.explanation,JSON.stringify(item.keyPoints),item.subject ?? null,item.createdAt])
  }

  async listRecordings(limit = 50): Promise<RecordingRecord[]> {
    return this.ensureOpen().all('SELECT * FROM recordings ORDER BY created_at DESC LIMIT ?', [limit]).map((row) => ({
      id: toText(row.id), kind: toText(row.kind) as RecordingRecord['kind'], filePath: toText(row.file_path), sizeBytes: toInt(row.size_bytes), durationMs: toInt(row.duration_ms), detectedProcess: row.detected_process === null ? undefined : toText(row.detected_process), transcriptId: row.transcript_id === null ? undefined : toText(row.transcript_id), createdAt: toInt(row.created_at)
    }))
  }

  async putRecording(record: RecordingRecord): Promise<void> {
    this.ensureOpen().run(`INSERT INTO recordings (id,kind,file_path,size_bytes,duration_ms,detected_process,transcript_id,created_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path,size_bytes=excluded.size_bytes,duration_ms=excluded.duration_ms,transcript_id=excluded.transcript_id`, [record.id,record.kind,record.filePath,record.sizeBytes,record.durationMs,record.detectedProcess ?? null,record.transcriptId ?? null,record.createdAt])
  }

  async deleteRecording(id: string): Promise<void> { this.ensureOpen().run('DELETE FROM recordings WHERE id=?', [id]) }

  async totalRecordingBytes(): Promise<number> {
    return toInt(this.ensureOpen().get('SELECT COALESCE(SUM(size_bytes),0) AS total FROM recordings')?.total)
  }

  async listSolveRecords(limit = 50): Promise<SolveRecord[]> {
    return this.ensureOpen().all('SELECT * FROM solve_records ORDER BY created_at DESC LIMIT ?', [limit]).map((row) => ({
      id: toText(row.id), questionText: toText(row.question_text), answer: toText(row.answer), imagePath: row.image_path === null ? undefined : toText(row.image_path), createdAt: toInt(row.created_at)
    }))
  }

  async putSolveRecord(record: SolveRecord): Promise<void> {
    this.ensureOpen().run(`INSERT INTO solve_records (id,question_text,answer,image_path,created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET question_text=excluded.question_text,answer=excluded.answer,image_path=excluded.image_path`, [record.id,record.questionText,record.answer,record.imagePath ?? null,record.createdAt])
  }

  async putUsage(record: UsageRecord): Promise<void> {
    this.ensureOpen().run('INSERT INTO usage_records (id,feature,provider_id,model,prompt_tokens,completion_tokens,created_at) VALUES (?,?,?,?,?,?,?)', [record.id,record.feature,record.providerId,record.model,record.promptTokens,record.completionTokens,record.createdAt])
  }

  async sumUsage(sinceMs: number): Promise<{ promptTokens: number; completionTokens: number }> {
    const row = this.ensureOpen().get('SELECT COALESCE(SUM(prompt_tokens),0) AS prompt,COALESCE(SUM(completion_tokens),0) AS completion FROM usage_records WHERE created_at>=?', [sinceMs])
    return { promptTokens: toInt(row?.prompt), completionTokens: toInt(row?.completion) }
  }
}
