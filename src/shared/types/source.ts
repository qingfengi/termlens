import type { Term } from './term'

export interface SourceSegment {
  id: string
  label: string
  text: string
  /** 课程字幕的开始时间（秒）。 */
  startSeconds?: number
  terms?: Term[]
}

export interface ExtractedSource {
  title: string
  kind: 'file' | 'web' | 'video' | 'window'
  location: string
  format: string
  segments: SourceSegment[]
  coverage: 'complete' | 'partial'
  coverageNote: string
  warnings: string[]
}

export interface SourceMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  citations: Array<{ segmentId: string; label: string }>
  error?: string
}

export interface SourceDocument extends ExtractedSource {
  id: string
  createdAt: number
  analysis: 'none' | 'partial' | 'complete'
  analyzedSegmentIds: string[]
  messages: SourceMessage[]
}

export interface SourceSummary {
  id: string
  title: string
  kind: ExtractedSource['kind']
  format: string
  coverage: ExtractedSource['coverage']
  segmentCount: number
  createdAt: number
}

export interface SourceRequest {
  kind: 'file' | 'url' | 'window'
  location?: string
}

export interface SourceTask {
  id: string
  title: string
  action: 'read' | 'analyze' | 'ask'
  state: 'queued' | 'running' | 'complete' | 'cancelled' | 'failed'
  progress: string
  sourceId?: string
  error?: string
}

export interface SourceStatus {
  paused: boolean
  tasks: SourceTask[]
}

export const SOURCE_LIMITS = { fileBytes: 25 * 1024 * 1024, characters: 500000, segments: 1000, segmentCharacters: 12000 } as const
