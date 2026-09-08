/**
 * 数据仓储接口（需求 FR-8.1 / 决策 D7 / 任务 T0.10）
 *
 * 刻意与具体存储引擎解耦：本地为 SQLite(WASM)，
 * 未来手机端与云同步复用同一套协议（FR-8.5 / NFR-9）。
 */

import type { ConceptThread, Explanation, ExplanationLevel, Term } from '@shared/types/term'
import type { ReaderDocument } from '@shared/ipc/api'

export interface CachedExplanation extends Explanation {
  cacheKey: string
}

export interface TranscriptRecord {
  id: string
  title: string
  /** 原始转写文本 */
  rawText: string
  /** 排版后文本（FR-3） */
  formattedText?: string
  language: string
  durationMs: number
  /** 来源：口述 / 文件导入 / 会议录制 */
  origin: 'dictation' | 'file' | 'meeting'
  createdAt: number
}

export interface StudyItem {
  id: string
  question: string
  /** 讲解式解答（FR-2.1），与开发者模式的"快答"分离 */
  explanation: string
  keyPoints: string[]
  subject?: string
  createdAt: number
}

export interface RecordingRecord {
  id: string
  kind: 'audio' | 'screen'
  filePath: string
  sizeBytes: number
  durationMs: number
  /** 触发录制的会议进程名（FR-5.1） */
  detectedProcess?: string
  transcriptId?: string
  createdAt: number
}

export interface SolveRecord {
  id: string
  /** 截图 OCR 得到的题面 */
  questionText: string
  answer: string
  imagePath?: string
  createdAt: number
}

export interface CustomTerm {
  canonical: string
  aliases: string[]
  domain: string
  brief: string
  detail?: string
  createdAt: number
}

export interface UsageRecord {
  id: string
  feature: string
  providerId: string
  model: string
  promptTokens: number
  completionTokens: number
  createdAt: number
}

export interface Repository {
  init(): Promise<void>
  close(): void

  // 术语解释缓存（FR-4.10 三级瀑布第二级）
  getExplanation(
    canonical: string,
    domain: string,
    level: ExplanationLevel
  ): Promise<CachedExplanation | undefined>
  putExplanation(explanation: Explanation): Promise<void>
  /** 用户自定义术语（FR-4.9） */
  listCustomTerms(): Promise<CustomTerm[]>
  putCustomTerm(term: CustomTerm): Promise<void>
  deleteCustomTerm(canonical: string): Promise<void>

  // 概念会话线程（FR-4.5 / FR-4.7）
  getThread(threadId: string): Promise<ConceptThread | undefined>
  putThread(thread: ConceptThread): Promise<void>
  listChildThreads(parentThreadId: string): Promise<ConceptThread[]>
  listThreads(): Promise<ConceptThread[]>
  listReaderDocuments(): Promise<ReaderDocument[]>
  putReaderDocument(document: ReaderDocument): Promise<void>
  deleteReaderDocument(id: string): Promise<void>

  // 转写稿（FR-1.7）
  listTranscripts(limit?: number): Promise<TranscriptRecord[]>
  getTranscript(id: string): Promise<TranscriptRecord | undefined>
  putTranscript(record: TranscriptRecord): Promise<void>

  // 题目学习历史（FR-2.5）
  listStudyItems(limit?: number): Promise<StudyItem[]>
  putStudyItem(item: StudyItem): Promise<void>

  // 录制元数据（FR-5.7）
  listRecordings(limit?: number): Promise<RecordingRecord[]>
  putRecording(record: RecordingRecord): Promise<void>
  deleteRecording(id: string): Promise<void>
  totalRecordingBytes(): Promise<number>

  // 解题历史（FR-6.4，仅开发者模式写入）
  listSolveRecords(limit?: number): Promise<SolveRecord[]>
  putSolveRecord(record: SolveRecord): Promise<void>

  // Token 用量统计（FR-7.7）
  putUsage(record: UsageRecord): Promise<void>
  sumUsage(sinceMs: number): Promise<{ promptTokens: number; completionTokens: number }>
}

/** 缓存键：术语 + 领域 + 难度，三者任一不同即不同解释（FR-4.12） */
export function explanationCacheKey(
  canonical: string,
  domain: string,
  level: ExplanationLevel
): string {
  return `${canonical.toLowerCase()}|${domain}|${level}`
}

export type { Term }
