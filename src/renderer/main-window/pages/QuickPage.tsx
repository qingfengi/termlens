import { Fragment, useEffect, useRef, useState } from 'react'
import type { SelectionSnapshot } from '@shared/ipc/api'
import type { SelectionExplanation } from '@shared/ipc/api'
import type { ConceptThread, Explanation, Term } from '@shared/types/term'
import { api, errorText, Notice } from './ui'

type Frame = { thread: ConceptThread; explanation: Explanation; term: Term }

export function QuickPage(): JSX.Element {
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const [terms, setTerms] = useState<Term[]>([])
  const [frames, setFrames] = useState<Frame[]>([])
  const [question, setQuestion] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'reading' | 'explaining' | 'prefetching'>('idle')
  const [automatic, setAutomatic] = useState(false)
  const [useAi, setUseAi] = useState(false)
  const [hotkey, setHotkey] = useState('Ctrl + Shift + Space')
  const [queued, setQueued] = useState<SelectionSnapshot>()
  const [paused, setPaused] = useState(false)
  const [maxNestedDepth, setMaxNestedDepth] = useState(10)
  const [selectionMode, setSelectionMode] = useState<'explain' | 'tokenize'>('explain')
  const [speedMode, setSpeedMode] = useState(true)
  const [speedConcurrency, setSpeedConcurrency] = useState(3)
  const [prefetch, setPrefetch] = useState({ done: 0, total: 0, failed: 0 })
  const [selectionExplanation, setSelectionExplanation] = useState<SelectionExplanation>()
  const [recentConcepts, setRecentConcepts] = useState<string[]>([])
  const lastSelection = useRef(0)
  const sequence = useRef(0)
  const selectionContext = useRef<string[]>([])
  const latest = useRef({ busy, question, useAi, selectionMode, speedMode, speedConcurrency })
  latest.current = { busy, question, useAi, selectionMode, speedMode, speedConcurrency }
  const active = frames.at(-1)

  useEffect(() => {
    let disposed = false
    void api().configGet().then((config) => {
      if (!disposed) { setAutomatic(config.term.selectionAuto); setHotkey(config.term.selectionHotkey.replace('Control', 'Ctrl').replaceAll('+', ' + ')); setMaxNestedDepth(config.term.maxNestedDepth); setSelectionMode(config.term.selectionMode); setSpeedMode(config.term.speedMode); setSpeedConcurrency(config.term.speedConcurrency) }
    }).catch((failure) => { if (!disposed) setError(errorText(failure)) })
    void api().termHistory().then((history) => { if (!disposed) setRecentConcepts([...new Set(history.flatMap((thread) => thread.path.map((term) => term.canonical)))].slice(-20)) }).catch(() => {})
    const timer = setInterval(() => {
      void api().sourceStatus().then((status) => { if (!disposed) setPaused(status.paused) }).catch(() => {})
      void api().selectionGet().then((selection) => {
        if (disposed || !selection.id || selection.id === lastSelection.current) return
        lastSelection.current = selection.id
        if (!selection.text) { if (selection.error) setError(selection.error); return }
        if (latest.current.busy || latest.current.question.trim()) { setQueued(selection); return }
        void accept(selection)
      }).catch((failure) => { if (!disposed) setError(errorText(failure)) })
    }, 350)
    return () => { disposed = true; clearInterval(timer) }
  }, [])

  async function accept(selection: SelectionSnapshot): Promise<void> {
    selectionContext.current = [...recentConcepts, ...frames.flatMap((frame) => frame.thread.path.map((term) => term.canonical))]
    setQueued(undefined)
    setFrames([])
    setSelectionExplanation(undefined)
    setQuestion('')
    setText(selection.text)
    setEditing(false)
    setTerms([])
    setPrefetch({ done: 0, total: 0, failed: 0 })
    setError(selection.error ?? '')
    if (selection.text) await analyze(selection.text, true)
  }

  async function analyze(source = text, save = false): Promise<void> {
    if (!source.trim()) return
    const run = ++sequence.current
    setBusy(true)
    setPhase('reading')
    setPrefetch({ done: 0, total: 0, failed: 0 })
    setError('')
    try {
      if (save) await api().readerSave({ title: source.trim().slice(0, 60), text: source })
      const result = await api().termDetect({ text: source, useAi: latest.current.useAi })
      if (run !== sequence.current) return
      setTerms(result.terms)
      if (result.warning) setError(result.warning)
      if (latest.current.selectionMode === 'explain') {
        setPhase('explaining')
        setSelectionExplanation(undefined)
        try {
          const explained = await api().termExplainSelection({ text: source, contextTerms: selectionContext.current })
          if (run === sequence.current) setSelectionExplanation(explained)
        } catch (failure) { if (run === sequence.current) setError(errorText(failure)) }
        return
      }
      if (source.trim().length <= 100 && latest.current.selectionMode === 'tokenize') {
        const trimmed = source.trim()
        const term = result.terms.find((item) => item.surface === trimmed) ?? {
          id: `selection_${Date.now()}`, surface: trimmed, canonical: trimmed, domain: 'general',
          range: [source.indexOf(trimmed), source.indexOf(trimmed) + trimmed.length] as [number, number], confidence: 1, source: 'llm' as const
        }
        const opened = await api().termDetail({ term })
        if (run === sequence.current) setFrames([{ ...opened, term }])
      }
      if (latest.current.selectionMode === 'tokenize' && latest.current.speedMode && result.terms.length > 0) {
        setPhase('prefetching')
        void prefetchTerms(result.terms, run, latest.current.speedConcurrency)
      } else {
        setPrefetch({ done: 0, total: 0, failed: 0 })
      }
    } catch (failure) { if (run === sequence.current) setError(errorText(failure)) }
    finally { if (run === sequence.current) { setBusy(false); setPhase('idle') } }
  }

  async function prefetchTerms(found: Term[], run: number, concurrency: number): Promise<void> {
    const unique = [...new Map(found.map((term) => [`${term.canonical.toLowerCase()}|${term.domain}`, term])).values()]
    let cursor = 0
    let done = 0
    let failed = 0
    setPrefetch({ done: 0, total: unique.length, failed: 0 })
    const worker = async (): Promise<void> => {
      while (cursor < unique.length) {
        if (run !== sequence.current) return
        const term = unique[cursor++]
        try { await api().termBrief(term) } catch { failed += 1 }
        done += 1
        if (run === sequence.current) setPrefetch({ done, total: unique.length, failed })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()))
  }

  async function open(term: Term, parents: Frame[] = []): Promise<void> {
    if (parents.length + 1 > maxNestedDepth) { setError(`已达到概念嵌套上限（${maxNestedDepth} 层），请返回上一级。`); return }
    const run = ++sequence.current
    setBusy(true)
    setError('')
    try {
      const result = await api().termDetail({ term, parentThreadId: parents.at(-1)?.thread.threadId })
      if (run === sequence.current) { setFrames([...parents, { ...result, term }]); setQuestion('') }
    } catch (failure) { if (run === sequence.current) setError(errorText(failure)) }
    finally { if (run === sequence.current) setBusy(false) }
  }

  async function ask(): Promise<void> {
    if (!active || !question.trim() || busy) return
    setBusy(true)
    setError('')
    const threadId = active.thread.threadId
    try {
      const thread = await api().termFollowup({ threadId, question })
      setFrames((previous) => previous.map((frame) => frame.thread.threadId === threadId ? { ...frame, thread } : frame))
      setQuestion('')
    } catch (failure) {
      setError(errorText(failure))
      try {
        const thread = await api().termThread(threadId)
        if (thread) setFrames((previous) => previous.map((frame) => frame.thread.threadId === threadId ? { ...frame, thread } : frame))
      } catch { /* Keep the existing visible conversation when reloading fails. */ }
    } finally { setBusy(false) }
  }

  async function toggleAutomatic(enabled: boolean): Promise<void> {
    try { await api().selectionConfigure({ automatic: enabled }); setAutomatic(enabled); setError('') }
    catch (failure) { setError(errorText(failure)) }
  }

  function annotated(): React.ReactNode {
    let offset = 0
    const nodes: React.ReactNode[] = []
    for (const term of terms) {
      const [start, end] = term.range
      if (start < offset || end > text.length || text.slice(start, end) !== term.surface) continue
      nodes.push(<Fragment key={term.id}>{text.slice(offset, start)}<button className="term-inline" onClick={() => void open(term)} disabled={busy}>{term.surface}</button></Fragment>)
      offset = end
    }
    nodes.push(text.slice(offset))
    return nodes
  }

  return (
    <div className="quick-shell">
      <header className="quick-header"><strong>TermLens</strong><div><button onClick={() => void api().selectionOpenManager()}>记录与设置</button><button className="quick-close" type="button" aria-label="关闭浮窗" title="关闭浮窗" onClick={() => void api().selectionHide()}><span aria-hidden="true">×</span></button></div></header>
      <div className="quick-controls">
        <button type="button" onClick={() => void api().sourceOpenReader().catch((error) => setError(errorText(error)))}>资料阅读</button>
        <label><input type="checkbox" checked={automatic} onChange={(event) => void toggleAutomatic(event.target.checked)} />选中即解释</label>
        <label>选区模式 <select aria-label="选区处理模式" value={selectionMode} onChange={(event) => { const mode = event.target.value as 'explain' | 'tokenize'; setSelectionMode(mode); void api().configUpdate({ term: { selectionMode: mode } }).catch((failure) => setError(errorText(failure))) }}><option value="explain">整段解释</option><option value="tokenize">只分词</option></select></label>
        <details className="quick-advanced"><summary>更多设置</summary><div className="quick-advanced-content">
          <label><input type="checkbox" checked={paused} onChange={(event) => void api().sourcePause({ paused: event.target.checked }).then((status) => setPaused(status.paused)).catch((error) => setError(errorText(error)))} />暂停助手</label>
          <label><input type="checkbox" checked={useAi} onChange={(event) => setUseAi(event.target.checked)} />本次启用 AI 分词</label>
          <label><input type="checkbox" checked={speedMode} onChange={(event) => { const enabled = event.target.checked; setSpeedMode(enabled); void api().configUpdate({ term: { speedMode: enabled } }).catch((failure) => setError(errorText(failure))) }} />速度模式</label>
          {speedMode && <label>并发 <input aria-label="术语并发数" type="number" min={1} max={8} value={speedConcurrency} onChange={(event) => { const value = Math.max(1, Math.min(8, Number(event.target.value) || 1)); setSpeedConcurrency(value); void api().configUpdate({ term: { speedConcurrency: value } }).catch((failure) => setError(errorText(failure))) }} /></label>}
        </div></details>
      </div>
      {queued && <div className="quick-queued"><span>有新的选中文字</span><button disabled={busy} onClick={() => void accept(queued)}>打开</button></div>}
      <section className="quick-input">
        {editing ? <><label htmlFor="quick-text">文字</label><textarea id="quick-text" value={text} disabled={busy} maxLength={16000} rows={3} onChange={(event) => { sequence.current++; setText(event.target.value); setTerms([]); setFrames([]) }} /><button disabled={busy || !text.trim()} onClick={() => { setEditing(false); void analyze(text, true) }}>解释</button></> : <>
          {text ? <div className="quick-annotated">{annotated()}</div> : <div className="quick-empty"><h1>选中，就在这里解释</h1><p>在其他软件里选中文字，按 <kbd>{hotkey}</kbd>。</p><p>开启“选中即解释”后，选择文字就会弹出浮窗。无需先把文章输入到这里。</p></div>}
          <button disabled={busy} onClick={() => setEditing(true)}>{text ? '编辑文字' : '粘贴文字'}</button>
        </>}
        {busy && <span role="status">{phase === 'reading' ? '正在读取选中文字…' : '正在组织解释…'}</span>}
        {!busy && prefetch.total > 0 && <span role="status">速度模式：已处理 {prefetch.done}/{prefetch.total}{prefetch.failed ? `，失败 ${prefetch.failed}` : ''}</span>}
        {!busy && selectionExplanation && <section className="quick-selection-explanation" aria-label="整段解释"><h2>整段解释</h2><p>{selectionExplanation.summary}</p>{selectionExplanation.context && <p><strong>与上一轮概念的关系：</strong>{selectionExplanation.context}</p>}<h3>词语拆分</h3><ul>{selectionExplanation.termExplanations.map((item) => <li key={`${item.surface}-${item.explanation}`}><strong>{item.surface}</strong>：{item.explanation}</li>)}</ul><span className="source-label">AI 生成 · 基于当前选区</span></section>}
      </section>
      {error && <Notice error>{error}</Notice>}
      {frames.length > 0 && <nav className="quick-breadcrumb" aria-label="概念路径">{frames.map((frame, index) => <button key={frame.thread.threadId} disabled={busy} onClick={() => { setFrames(frames.slice(0, index + 1)); setQuestion('') }}>{frame.term.canonical}</button>)}</nav>}
      {active && <section className="quick-detail">
        <h1>{active.term.canonical}</h1><span className="source-label">{active.explanation.source === 'lexicon' ? '本地词库' : active.explanation.source === 'cache' ? '本地缓存' : 'AI 生成'}</span>
        <p>{active.explanation.detail?.definition ?? active.explanation.brief}</p>
        {active.explanation.detail?.background && <p>{active.explanation.detail.background}</p>}
        {!!active.explanation.detail?.keyPoints.length && <ul>{active.explanation.detail.keyPoints.map((point, index) => <li key={index}>{point}</li>)}</ul>}
        <div className="quick-related">{active.explanation.detail?.related.map((canonical) => <button disabled={busy || frames.length >= maxNestedDepth} title={frames.length >= maxNestedDepth ? `已达到 ${maxNestedDepth} 层上限` : undefined} key={canonical} onClick={() => {
          void api().termDetect({ text: canonical }).then((result) => open(result.terms.find((term) => term.canonical === canonical) ?? { id: `related_${Date.now()}`, canonical, surface: canonical, domain: 'general', range: [0, canonical.length], confidence: 1, source: 'llm' }, frames)).catch((failure) => setError(errorText(failure)))
        }}>{canonical}</button>)}</div>
        <div className="quick-messages" aria-live="polite">{active.thread.messages.map((message) => <article key={message.id} className={message.role}><strong>{message.role === 'user' ? '我的追问' : '回答'}</strong><p>{message.content}</p></article>)}</div>
        <form className="quick-question" onSubmit={(event) => { event.preventDefault(); void ask() }}><label htmlFor="quick-question">继续追问</label><textarea id="quick-question" value={question} disabled={busy} maxLength={4000} rows={2} onChange={(event) => setQuestion(event.target.value)} /><button disabled={busy || !question.trim()} type="submit">发送</button></form>
      </section>}
    </div>
  )
}
