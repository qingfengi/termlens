import type { AppSettingsParsed } from '../config/schema'
import type { ProviderConfig, ProviderModelsRequest, ProviderModelsResult, TestResult } from '../types/provider'
import type { ConceptThread, Explanation, ExplanationLevel, Term } from '../types/term'

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

export interface OpenTermRequest {
  term: Term
  parentThreadId?: string
  threadId?: string
  level?: ExplanationLevel
}

export interface TermLensApi {
  configGet(): Promise<AppSettingsParsed>
  configUpdate(patch: Partial<AppSettingsParsed>): Promise<AppSettingsParsed>
  providerList(): Promise<ProviderConfig[]>
  providerUpsert(provider: ProviderConfig): Promise<AppSettingsParsed>
  providerRemove(id: string): Promise<AppSettingsParsed>
  providerTest(id: string): Promise<TestResult>
  providerModels(request: ProviderModelsRequest): Promise<ProviderModelsResult>
  termDetect(request: { text: string; useAi?: boolean }): Promise<TermAnalysis>
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
