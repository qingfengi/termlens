/**
 * 双形态定义（硬约束 C-13 / C-14，需求 FR-6.1 / FR-6.2）
 *
 * public    对外形态：复刻 typeless（语音转写 + 题目学习 + 自动排版）
 *                     + 扩展层（术语解释、会议自动录制）
 * developer 对内形态：额外解锁自动解题、全屏 OCR 标注、防录屏、AI 聊天客户端
 */
export type AppMode = 'public' | 'developer'

/** 通用三态开关（FR-5.3 会议录音/录屏各自独立使用） */
export type TriState = 'auto' | 'manual' | 'off'

/** 术语解释难度分级（FR-4.12） */
export type ExplanationLevel = 'beginner' | 'intermediate' | 'expert'

/** 术语来源，用于三级瀑布可观测性（FR-4.10 / 决策 D6） */
export type TermSource = 'lexicon' | 'cache' | 'llm'

/** 术语标注视觉样式（FR-4.2） */
export type TermMarkStyle = 'deepen' | 'outline'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 识别出的术语 */
export interface Term {
  id: string
  /** 原文中的表面形式 */
  surface: string
  /** 规范名，用于缓存与词库对齐 */
  canonical: string
  /** 领域标签，如 marxism / ai / economics */
  domain: string
  /** 文本字符区间 [start, end)，阅读器精准模式使用（FR-4.11） */
  range: [number, number]
  /** 屏幕坐标，全屏 OCR 模式使用（FR-6.5） */
  bbox?: Rect
  confidence: number
  source: TermSource
}

/** 术语详解正文结构（FR-4.4） */
export interface TermDetail {
  definition: string
  background: string
  keyPoints: string[]
  related: string[]
}

export interface Explanation {
  termId: string
  canonical: string
  domain: string
  level: ExplanationLevel
  /** 悬停简释，1~2 句（FR-4.3） */
  brief: string
  /** 点击详解，懒加载（FR-4.4） */
  detail?: TermDetail
  /** 详解正文中的子概念，支持继续下钻（FR-4.6） */
  subTerms: Term[]
  source: TermSource
  updatedAt: number
}

/** 追问会话消息 */
export interface ThreadMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

/**
 * 概念会话线程（FR-4.5 / FR-4.7 / 决策 D11）
 * path 为面包屑：父术语 → 子概念 → 孙概念，无层数上限
 */
export interface ConceptThread {
  threadId: string
  parentThreadId?: string
  path: Term[]
  messages: ThreadMessage[]
  createdAt: number
}
