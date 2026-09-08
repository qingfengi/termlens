/**
 * SQLite 表结构（任务 T0.10，design.md 第 4.7 节）
 * 迁移以数组顺序执行，version 记录在 PRAGMA user_version。
 */

export interface Migration {
  version: number
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      -- 解释缓存：三级瀑布第二级（FR-4.10）
      CREATE TABLE IF NOT EXISTS explanations (
        cache_key   TEXT PRIMARY KEY,
        canonical   TEXT NOT NULL,
        domain      TEXT NOT NULL,
        level       TEXT NOT NULL,
        brief       TEXT NOT NULL,
        detail_json TEXT,
        sub_terms_json TEXT NOT NULL DEFAULT '[]',
        source      TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_expl_canonical ON explanations(canonical);

      -- 用户自定义术语（FR-4.9）
      CREATE TABLE IF NOT EXISTS custom_terms (
        canonical    TEXT PRIMARY KEY,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        domain       TEXT NOT NULL,
        brief        TEXT NOT NULL,
        detail       TEXT,
        created_at   INTEGER NOT NULL
      );

      -- 概念会话线程与面包屑（FR-4.5 / FR-4.7 / 决策 D11）
      CREATE TABLE IF NOT EXISTS threads (
        thread_id        TEXT PRIMARY KEY,
        parent_thread_id TEXT,
        path_json        TEXT NOT NULL,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_thread_id);

      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        thread_id  TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

      -- 转写稿（FR-1.7）
      CREATE TABLE IF NOT EXISTS transcripts (
        id             TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        raw_text       TEXT NOT NULL,
        formatted_text TEXT,
        language       TEXT NOT NULL DEFAULT 'auto',
        duration_ms    INTEGER NOT NULL DEFAULT 0,
        origin         TEXT NOT NULL,
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transcripts_created ON transcripts(created_at DESC);

      -- 题目学习历史（FR-2.5）
      CREATE TABLE IF NOT EXISTS study_items (
        id              TEXT PRIMARY KEY,
        question        TEXT NOT NULL,
        explanation     TEXT NOT NULL,
        key_points_json TEXT NOT NULL DEFAULT '[]',
        subject         TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_study_created ON study_items(created_at DESC);

      -- 录制元数据（FR-5.7）
      CREATE TABLE IF NOT EXISTS recordings (
        id               TEXT PRIMARY KEY,
        kind             TEXT NOT NULL,
        file_path        TEXT NOT NULL,
        size_bytes       INTEGER NOT NULL DEFAULT 0,
        duration_ms      INTEGER NOT NULL DEFAULT 0,
        detected_process TEXT,
        transcript_id    TEXT,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recordings_created ON recordings(created_at DESC);

      -- 解题历史（FR-6.4，开发者模式）
      CREATE TABLE IF NOT EXISTS solve_records (
        id            TEXT PRIMARY KEY,
        question_text TEXT NOT NULL,
        answer        TEXT NOT NULL,
        image_path    TEXT,
        created_at    INTEGER NOT NULL
      );

      -- Token 用量（FR-7.7）
      CREATE TABLE IF NOT EXISTS usage_records (
        id                TEXT PRIMARY KEY,
        feature           TEXT NOT NULL,
        provider_id       TEXT NOT NULL,
        model             TEXT NOT NULL,
        prompt_tokens     INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at DESC);

      -- 同步版本向量与冲突记录（FR-8.4）
      CREATE TABLE IF NOT EXISTS sync_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 2,
    sql: `CREATE TABLE IF NOT EXISTS reader_documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`
  },
  {
    version: 3,
    sql: `CREATE TABLE IF NOT EXISTS source_documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, format TEXT NOT NULL,
      coverage TEXT NOT NULL, segment_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );`
  }
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
