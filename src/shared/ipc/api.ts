import type { AppSettingsParsed } from '../config/schema'
import type { ProviderConfig, ProviderModelsRequest, ProviderModelsResult, TestResult } from '../types/provider'
import type { ConceptThread, Explanation, ExplanationLevel, Term } from '../types/term'
import type { SourceDocument, SourceRequest, SourceStatus, SourceSummary, SourceTask } from '../types/source'

export interface ReaderDocument {
  id: string
  title: string
  text: string
  createdAt: number
  updatedAt: number
}

export interface SelectionSnapshot {
  id: number
  text: string
  automatic: boolean
  error?: string
}

export interface TermAnalysis {
  terms: Term[]
  warning?: string
}

export interface SelectionExplanation {
  text: string
  summary: string
  termExplanations: Array<{ surface: string; explanation: string }>
  context: string
  source: 'llm'
}

export interface OpenTermRequest {
  term: Term
  parentThreadId?: string
  threadId?: string
  level?: ExplanationLevel
}

export interface TermLensApi {
  sourcePickFile(): Promise<string | null>
  sourceImport(request: SourceRequest): Promise<SourceTask>
  sourceStatus(): Promise<SourceStatus>
  sourcePause(request: { paused: boolean }): Promise<SourceStatus>
  sourceCancel(taskId: string): Promise<void>
  sourceList(): Promise<SourceSummary[]>
  sourceGet(id: string): Promise<SourceDocument | undefined>
  sourceDelete(id: string): Promise<void>
  sourceAnalyze(request: { id: string; useAi: boolean }): Promise<SourceTask>
  sourceAsk(request: { id: string; question: string; segmentId?: string; term?: string }): Promise<SourceTask>
  sourceOpenLocation(request: { id: string; segmentId?: string }): Promise<void>
  sourceOpenReader(): Promise<void>
  configGet(): Promise<AppSettingsParsed>
  configUpdate(patch: Partial<Omit<AppSettingsParsed, 'term'>> & { term?: Partial<AppSettingsParsed['term']> }): Promise<AppSettingsParsed>
  providerList(): Promise<ProviderConfig[]>
  providerUpsert(provider: ProviderConfig): Promise<AppSettingsParsed>
  providerRemove(id: string): Promise<AppSettingsParsed>
  providerTest(id: string): Promise<TestResult>
  providerModels(request: ProviderModelsRequest): Promise<ProviderModelsResult>
  termDetect(request: { text: string; useAi?: boolean; tokenize?: boolean }): Promise<TermAnalysis>
  termExplainSelection(request: { text: string; contextTerms?: string[] }): Promise<SelectionExplanation>
  termBrief(term: Term): Promise<Explanation>
  termDetail(request: OpenTermRequest): Promise<{ explanation: Explanation; thread: ConceptThread }>
  termFollowup(request: { threadId: string; question: string }): Promise<ConceptThread>
  termThread(threadId: string): Promise<ConceptThread | undefined>
  termHistory(): Promise<ConceptThread[]>
  termCustomUpsert(request: { canonical: string; domain: string; brief: string; detail?: string; aliases: string[] }): Promise<void>
  readerList(): Promise<ReaderDocument[]>
  readerSave(request: { id?: string; title: string; text: string }): Promise<ReaderDocument>
  readerDelete(id: string): Promise<void>
  selectionGet(): Promise<SelectionSnapshot>
  selectionConfigure(request: { automatic: boolean }): Promise<void>
  selectionOpenManager(): Promise<void>
  selectionHide(): Promise<void>
  windowMinimize(): Promise<void>
  windowClose(): Promise<void>
}

declare global {
  interface Window {
    termlens?: TermLensApi
  }
}
