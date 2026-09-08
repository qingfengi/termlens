import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ReaderDocument } from '@shared/ipc/api'
import type { ConceptThread, Explanation, ExplanationLevel, Term } from '@shared/types/term'
import { api, dateText, errorText, Notice } from './ui'

type Frame = { term: Term; thread: ConceptThread; explanation?: Explanation }
type BriefPreview = { term: Term; left: number; top: number; explanation?: Explanation; error?: string }
const LEVELS: { value: ExplanationLevel; label: string }[] = [
  { value: 'beginner', label: '入门' }, { value: 'intermediate', label: '进阶' }, { value: 'expert', label: '深入' }
]
const SOURCE_NAMES = { lexicon: '本地词库', cache: '已缓存', llm: 'AI 生成' }
const EXAMPLE = '机器学习通过数据训练模型，从而发现规律并进行预测。训练过程中，过拟合会让模型在训练数据上表现很好，却无法应对新的数据。理解梯度下降、神经网络和注意力机制，有助于进一步理解大语言模型。'

function validTerms(text: string, terms: Term[]): Term[] {
  const sorted = terms.filter((term) => {
    const [start, end] = term.range
    return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length && text.slice(start, end) === term.surface
  }).sort((a, b) => a.range[0] - b.range[0] || b.range[1] - a.range[1])
  let end = 0
  return sorted.filter((term) => {
    if (term.range[0] < end) return false
    end = term.range[1]
    return true
  })
}

export function ReaderPage(): JSX.Element {
  const [documents, setDocuments] = useState<ReaderDocument[]>([])
  const [history, setHistory] = useState<ConceptThread[]>([])
  const [library, setLibrary] = useState<'documents' | 'concepts' | null>(null)
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryError, setLibraryError] = useState('')
  const [document, setDocument] = useState<ReaderDocument>()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(true)
  const [terms, setTerms] = useState<Term[]>([])
  const [useAi, setUseAi] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [documentError, setDocumentError] = useState('')
  const [documentNotice, setDocumentNotice] = useState('')
  const [level, setLevel] = useState<ExplanationLevel>('beginner')
  const [trail, setTrail] = useState<Frame[]>([])
  const [opening, setOpening] = useState('')
  const [detailError, setDetailError] = useState('')
  const [retryDetail, setRetryDetail] = useState(false)
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({})
  const [asking, setAsking] = useState(false)
  const [answerNotice, setAnswerNotice] = useState('')
  const [brief, setBrief] = useState<BriefPreview>()
  const briefCache = useRef(new Map<string, Explanation>())
  const briefTimer = useRef<ReturnType<typeof setTimeout>>()
  const briefSequence = useRef(0)
  const documentSequence = useRef(0)
  const detailSequence = useRef(0)
  const activeThreadId = useRef<string>()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const lastOpen = useRef<{ term: Term; parents: Frame[]; existing?: ConceptThread; level: ExplanationLevel }>()
  const active = trail.at(-1)
  activeThreadId.current = active?.thread.threadId
  const dirty = document ? text !== document.text || title !== document.title : Boolean(text || title)
  const question = active ? questionDrafts[active.thread.threadId] ?? '' : ''

  const loadLibrary = useCallback(async () => {
    setLibraryLoading(true)
    setLibraryError('')
    try {
      const [savedDocuments, savedThreads] = await Promise.all([api().readerList(), api().termHistory()])
      setDocuments(savedDocuments)
      setHistory(savedThreads)
    } catch (error) { setLibraryError(errorText(error)) }
    finally { setLibraryLoading(false) }
  }, [])

  useEffect(() => {
    void loadLibrary()
    return () => { if (briefTimer.current) clearTimeout(briefTimer.current) }
  }, [loadLibrary])

  useEffect(() => {
    if (active?.thread.threadId) headingRef.current?.focus({ preventScroll: window.innerWidth >= 800 })
  }, [active?.thread.threadId])

  function closeBrief(): void {
    if (briefTimer.current) clearTimeout(briefTimer.current)
    briefSequence.current += 1
    setBrief(undefined)
  }

  function showBrief(term: Term, target: HTMLElement): void {
    closeBrief()
    const sequence = briefSequence.current
    const bounds = target.getBoundingClientRect()
    const preview: BriefPreview = {
      term, left: Math.max(12, Math.min(bounds.left, window.innerWidth - 300)),
      top: bounds.bottom + 154 > window.innerHeight ? Math.max(12, bounds.top - 150) : bounds.bottom + 8
    }
    briefTimer.current = setTimeout(() => {
      const cached = briefCache.current.get(`${term.domain}:${term.canonical}`)
      setBrief({ ...preview, explanation: cached })
      if (cached) return
      void Promise.resolve().then(() => api().termBrief(term)).then((explanation) => {
        briefCache.current.set(`${term.domain}:${term.canonical}`, explanation)
        if (briefSequence.current === sequence) setBrief({ ...preview, explanation })
      }).catch((error: unknown) => {
        if (briefSequence.current === sequence) setBrief({ ...preview, error: errorText(error) })
      })
    }, 250)
  }

  function replaceDocument(next?: ReaderDocument): void {
    if (saving || (dirty && !window.confirm('当前原文尚未保存。放弃修改并打开另一份原文？'))) return
    documentSequence.current += 1
    setDocument(next)
    setTitle(next?.title ?? '')
    setText(next?.text ?? '')
    setTerms([])
    setEditing(!next)
    setLibrary(null)
    setDocumentError('')
    setDocumentNotice('')
    closeBrief()
  }

  function editText(value: string): void {
    documentSequence.current += 1
    setText(value)
    setTerms([])
    setDocumentNotice('')
    setDocumentError('')
    closeBrief()
  }

  async function saveDocument(): Promise<void> {
    if (!text.trim() || saving) return
    setSaving(true)
    setDocumentError('')
    const savedTitle = title.trim() || text.trim().split('\n')[0].slice(0, 40) || '未命名原文'
    try {
      const saved = await api().readerSave({ id: document?.id, title: savedTitle, text })
      setDocuments((previous) => [saved, ...previous.filter((item) => item.id !== saved.id)])
      setDocument(saved)
      setTitle(saved.title)
      setDocumentNotice('原文已保存')
    } catch (error) { setDocumentError(errorText(error)) }
    finally { setSaving(false) }
  }

  async function detect(): Promise<void> {
    if (!text.trim() || detecting) return
    setDetecting(true)
    setDocumentError('')
    setDocumentNotice('')
    const sequence = documentSequence.current
    try {
      const result = await api().termDetect({ text, useAi })
      if (sequence !== documentSequence.current) return
      const matched = validTerms(text, result.terms)
      setTerms(matched)
      setEditing(false)
      setDocumentNotice(result.warning || (matched.length ? `已识别 ${matched.length} 处术语` : '未识别到术语'))
    } catch (error) { if (sequence === documentSequence.current) setDocumentError(errorText(error)) }
    finally { setDetecting(false) }
  }

  async function openTerm(term: Term, parents: Frame[] = [], existing?: ConceptThread, requestedLevel = level): Promise<void> {
    const sequence = ++detailSequence.current
    lastOpen.current = { term, parents, existing, level: requestedLevel }
    closeBrief()
    setOpening(term.canonical)
    setDetailError('')
    setRetryDetail(false)
    setAnswerNotice('')
    if (existing) {
      setTrail((previous) => [...parents, { term, thread: existing, explanation: previous.find((frame) => frame.thread.threadId === existing.threadId)?.explanation }])
    }
    try {
      const result = await api().termDetail({ term, parentThreadId: parents.at(-1)?.thread.threadId, threadId: existing?.threadId, level: requestedLevel })
      setHistory((previous) => [result.thread, ...previous.filter((item) => item.threadId !== result.thread.threadId)])
      briefCache.current.set(`${term.domain}:${term.canonical}`, result.explanation)
      if (sequence === detailSequence.current) {
        lastOpen.current = { term, parents, existing: result.thread, level: requestedLevel }
        setTrail([...parents, { term, ...result }])
      }
    } catch (error) {
      if (sequence === detailSequence.current) { setDetailError(errorText(error)); setRetryDetail(true) }
    }
    finally { if (sequence === detailSequence.current) setOpening('') }
  }

  async function openHistory(thread: ConceptThread): Promise<void> {
    const sequence = ++detailSequence.current
    setOpening(thread.path.at(-1)?.canonical ?? '学习记录')
    setDetailError('')
    try {
      const parents: Frame[] = []
      const seen = new Set([thread.threadId])
      let parentId = thread.parentThreadId
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId)
        const parent = await api().termThread(parentId)
        if (!parent) break
        const term = parent.path.at(-1)
        if (term) parents.unshift({ term, thread: parent })
        parentId = parent.parentThreadId
      }
      if (sequence !== detailSequence.current) return
      const term = thread.path.at(-1)
      if (!term) throw new Error('这份学习记录缺少术语，无法打开。')
      setLibrary(null)
      await openTerm(term, parents, thread)
    } catch (error) {
      if (sequence === detailSequence.current) { setDetailError(errorText(error)); setOpening('') }
    }
  }

  function goBack(index: number): void {
    const frame = trail[index]
    if (!frame) return
    detailSequence.current += 1
    setOpening('')
    setDetailError('')
    setAnswerNotice('')
    if (frame.explanation) setTrail(trail.slice(0, index + 1))
    else void openTerm(frame.term, trail.slice(0, index), frame.thread)
  }

  function updateThread(thread: ConceptThread): void {
    setTrail((previous) => previous.map((frame) => frame.thread.threadId === thread.threadId ? { ...frame, thread } : frame))
    setHistory((previous) => [thread, ...previous.filter((item) => item.threadId !== thread.threadId)])
  }

  async function refreshThread(): Promise<void> {
    if (!active) return
    const threadId = active.thread.threadId
    setDetailError('')
    setRetryDetail(false)
    try {
      const thread = await api().termThread(threadId)
      if (!thread) throw new Error('未找到这份学习记录。')
      updateThread(thread)
    } catch (error) { if (activeThreadId.current === threadId) setDetailError(errorText(error)) }
  }

  async function askQuestion(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!active || !question.trim() || asking) return
    const threadId = active.thread.threadId
    const submittedQuestion = question.trim()
    setAsking(true)
    setDetailError('')
    setRetryDetail(false)
    setAnswerNotice('')
    try {
      const thread = await api().termFollowup({ threadId, question: submittedQuestion })
      updateThread(thread)
      setQuestionDrafts((previous) => ({ ...previous, [threadId]: previous[threadId]?.trim() === submittedQuestion ? '' : previous[threadId] }))
      if (activeThreadId.current === threadId) setAnswerNotice('对话已保存')
    } catch (error) {
      if (activeThreadId.current === threadId) setDetailError(errorText(error))
      try {
        const saved = await api().termThread(threadId)
        if (saved) {
          updateThread(saved)
          if (activeThreadId.current === threadId && saved.messages.some((message) => message.role === 'user' && message.content === submittedQuestion)) setAnswerNotice('问题已保存，回答尚未完成')
        }
      } catch { /* Keep the draft when saved history is temporarily unavailable. */ }
    } finally { setAsking(false) }
  }

  async function deleteDocument(item: ReaderDocument): Promise<void> {
    if (!window.confirm(`删除原文“${item.title}”？`)) return
    setLibraryError('')
    try {
      await api().readerDelete(item.id)
      setDocuments((previous) => previous.filter((entry) => entry.id !== item.id))
      if (document?.id === item.id) { setDocument(undefined); setDocumentNotice('已删除保存的原文，当前文字仍保留') }
    } catch (error) { setLibraryError(errorText(error)) }
  }

  const markedText: React.ReactNode[] = []
  let cursor = 0
  for (const term of terms) {
    markedText.push(<Fragment key={`text-${cursor}-${term.id}`}>{text.slice(cursor, term.range[0])}</Fragment>)
    markedText.push(<button key={`${term.id}-${term.range[0]}`} className="term-mark" type="button"
      aria-label={`解释 ${term.surface}`} aria-pressed={active?.term.canonical === term.canonical}
      aria-describedby={brief?.term.id === term.id ? 'term-brief' : undefined}
      onMouseEnter={(event) => showBrief(term, event.currentTarget)} onMouseLeave={closeBrief}
      onFocus={(event) => showBrief(term, event.currentTarget)} onBlur={closeBrief}
      onKeyDown={(event) => { if (event.key === 'Escape') closeBrief() }}
      onClick={() => void openTerm(term)}>{text.slice(term.range[0], term.range[1])}</button>)
    cursor = term.range[1]
  }
  markedText.push(<Fragment key="text-end">{text.slice(cursor)}</Fragment>)

  return (
    <div className="reader-page">
      <header className="page-toolbar"><h1>术语阅读</h1><div className="toolbar-actions">
        <button type="button" className="button-quiet" aria-expanded={library === 'documents'} onClick={() => { setLibrary(library === 'documents' ? null : 'documents'); void loadLibrary() }}>原文库 <span className="count">{documents.length}</span></button>
        <button type="button" className="button-quiet" aria-expanded={library === 'concepts'} onClick={() => { setLibrary(library === 'concepts' ? null : 'concepts'); void loadLibrary() }}>学习记录 <span className="count">{history.length}</span></button>
      </div></header>
      {library && <section className="library-panel" aria-label={library === 'documents' ? '原文库' : '学习记录'}>
        <div className="section-heading"><h2>{library === 'documents' ? '原文库' : '学习记录'}</h2><div className="toolbar-actions">
          <button type="button" className="icon-button" title="刷新记录" aria-label="刷新记录" disabled={libraryLoading} onClick={() => void loadLibrary()}>↻</button>
          <button type="button" className="icon-button" title="关闭记录" aria-label="关闭记录" onClick={() => setLibrary(null)}>×</button>
        </div></div>
        {libraryError && <Notice error>{libraryError}</Notice>}
        {libraryLoading && <p className="muted" role="status">正在读取记录…</p>}
        {!libraryLoading && !libraryError && (library === 'documents' ? documents.length === 0 : history.length === 0) && <p className="empty-line">暂无{library === 'documents' ? '保存的原文' : '学习记录'}</p>}
        <div className="record-list">{library === 'documents' ? documents.map((item) => <div className="record-row" key={item.id}>
          <button type="button" className="record-open" disabled={saving} onClick={() => replaceDocument(item)}><strong>{item.title}</strong><span>{dateText(item.updatedAt)} · {item.text.length} 字</span></button>
          <button type="button" className="icon-button danger-text" title={`删除 ${item.title}`} aria-label={`删除 ${item.title}`} disabled={saving} onClick={() => void deleteDocument(item)}>×</button>
        </div>) : history.map((thread) => <button type="button" className="record-open concept-record" key={thread.threadId} onClick={() => void openHistory(thread)}>
          <strong>{thread.path.map((term) => term.canonical).join(' / ') || '未命名术语'}</strong><span>{dateText(thread.createdAt)} · {thread.messages.filter((message) => message.role === 'user').length} 次追问</span>
        </button>)}</div>
      </section>}
      <div className="reading-workspace">
        <section className="source-panel" aria-label="阅读原文">
          <div className="source-heading"><input className="document-title" aria-label="原文标题" placeholder="未命名原文" value={title} disabled={saving} maxLength={200} onChange={(event) => { documentSequence.current += 1; setTitle(event.target.value); setDocumentNotice('') }} /><span className={`save-state${dirty ? ' is-dirty' : ''}`} role="status">{saving ? '正在保存…' : dirty ? '未保存' : document ? '已保存' : '新原文'}</span></div>
          <div className="document-tools"><div className="segmented" aria-label="原文模式"><button type="button" aria-pressed={editing} onClick={() => setEditing(true)}>编辑</button><button type="button" aria-pressed={!editing} onClick={() => setEditing(false)}>阅读</button></div><div className="toolbar-actions"><button type="button" className="icon-button" title="新建原文" aria-label="新建原文" disabled={saving} onClick={() => replaceDocument()}>+</button><button type="button" className="button-secondary" disabled={!text.trim() || saving || !dirty} onClick={() => void saveDocument()}>保存原文</button></div></div>
          <div className="source-content">{editing ? <textarea aria-label="阅读原文" placeholder="粘贴要阅读的文字" value={text} disabled={saving} onChange={(event) => editText(event.target.value)} spellCheck={false} /> : text ? <article className="reading-text" aria-label="带术语标注的原文">{markedText}</article> : <div className="source-empty"><p>原文为空</p><button type="button" className="button-secondary" onClick={() => setEditing(true)}>添加原文</button></div>}</div>
          <div className="source-footer"><span className="muted">{text.length.toLocaleString()} 字{terms.length > 0 ? ` · ${terms.length} 处术语` : ''}</span>{!text && <button type="button" className="text-button" disabled={saving} onClick={() => { editText(EXAMPLE); setTitle('机器学习概念'); setEditing(true) }}>打开示例原文</button>}</div>
          <div className="analysis-toolbar"><label className="checkbox-label"><input type="checkbox" checked={useAi} onChange={(event) => setUseAi(event.target.checked)} />AI 补充识别</label><button type="button" className="button-primary" disabled={!text.trim() || detecting} onClick={() => void detect()}>{detecting ? '正在识别…' : '识别术语'}</button></div>
          {documentError && <Notice error>{documentError}</Notice>}{documentNotice && <Notice>{documentNotice}</Notice>}
          {!library && libraryError && <Notice error>{libraryError} <button type="button" className="text-button" onClick={() => void loadLibrary()}>重试</button></Notice>}
        </section>
        <aside className="explanation-panel" aria-label="术语解释">
          <div className="explanation-heading"><h2>术语解释</h2><select aria-label="解释深度" value={level} disabled={Boolean(opening) || asking} onChange={(event) => { const next = event.target.value as ExplanationLevel; setLevel(next); if (active) void openTerm(active.term, trail.slice(0, -1), active.thread, next) }}>{LEVELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
          {trail.length > 0 && <nav className="concept-path" aria-label="概念路径">{trail.map((frame, index) => <Fragment key={frame.thread.threadId}>{index > 0 && <span aria-hidden="true">/</span>}<button type="button" className="text-button" aria-current={index === trail.length - 1 ? 'page' : undefined} onClick={() => goBack(index)}>{frame.term.canonical}</button></Fragment>)}</nav>}
          {opening && <div className="detail-loading" role="status">正在读取 {opening}…</div>}
          {detailError && <Notice error>{detailError}<div className="toolbar-actions">{retryDetail && lastOpen.current && <button type="button" className="text-button" onClick={() => { const request = lastOpen.current; if (request) void openTerm(request.term, request.parents, request.existing, request.level) }}>重试解释</button>}{active && <button type="button" className="text-button" onClick={() => void refreshThread()}>重新读取记录</button>}</div></Notice>}
          {!active && !opening && <div className="explanation-empty"><span className="empty-symbol" aria-hidden="true">Aa</span><p>尚未选择术语</p></div>}
          {active && <div className={`explanation-content${opening ? ' is-loading' : ''}`}>
            <div className="term-title-row">
              <h3 ref={headingRef} tabIndex={-1}>{active.explanation?.canonical ?? active.term.canonical}</h3>
              {active.explanation && <span className="source-label">{SOURCE_NAMES[active.explanation.source]}</span>}
            </div>
            {active.explanation && <p className="term-brief">{active.explanation.brief}</p>}
            {active.explanation?.detail && <div className="detail-sections">
              <section><h4>定义</h4><p>{active.explanation.detail.definition}</p></section>
              {active.explanation.detail.background && <section><h4>背景与理解</h4><p>{active.explanation.detail.background}</p></section>}
              {active.explanation.detail.keyPoints.length > 0 && <section><h4>关键要点</h4><ul>{active.explanation.detail.keyPoints.map((point, index) => <li key={index}>{point}</li>)}</ul></section>}
            </div>}
            {active.explanation && active.explanation.subTerms.length > 0 && <section className="related-concepts">
              <h4>继续理解</h4>
              <div>{active.explanation.subTerms.map((term, index) => <button type="button" className="concept-link" key={`${term.id}-${index}`} disabled={Boolean(opening)} onClick={() => void openTerm(term, trail)}>{term.canonical}<span aria-hidden="true">↗</span></button>)}</div>
            </section>}
            <section className="conversation"><div className="section-heading"><h4>追问</h4><button type="button" className="icon-button" title="刷新对话" aria-label="刷新对话" onClick={() => void refreshThread()}>↻</button></div>{active.thread.messages.length === 0 && <p className="muted empty-line">暂无追问</p>}
              <div className="messages" aria-live="polite">{active.thread.messages.map((message) => <div className={`message message-${message.role}`} key={message.id}><div className="message-heading"><strong>{message.role === 'user' ? '我' : 'TermLens'}</strong><time>{dateText(message.createdAt)}</time></div><p>{message.content}</p></div>)}</div>
              <form onSubmit={(event) => void askQuestion(event)} className="question-form"><textarea aria-label="追问内容" placeholder="写下你的问题" value={question} maxLength={10000} onChange={(event) => setQuestionDrafts((previous) => ({ ...previous, [active.thread.threadId]: event.target.value }))} rows={3} /><div className="question-actions"><span className="muted" role="status">{asking ? '正在回答…' : answerNotice}</span><button type="submit" className="button-primary" disabled={!question.trim() || asking || Boolean(opening)}>{asking ? '回答中…' : '发送追问'}</button></div></form>
            </section>
          </div>}
        </aside>
      </div>
      {brief && <div id="term-brief" className="brief-tooltip" role="tooltip" style={{ left: brief.left, top: brief.top }}><strong>{brief.term.canonical}</strong><p>{brief.error || brief.explanation?.brief || '正在读取简释…'}</p>{brief.explanation && <span>{SOURCE_NAMES[brief.explanation.source]}</span>}</div>}
    </div>
  )
}
