import { Fragment, useEffect, useRef, useState } from 'react'
import type { SelectionSnapshot } from '@shared/ipc/api'
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
  const [automatic, setAutomatic] = useState(false)
  const [useAi, setUseAi] = useState(false)
  const [hotkey, setHotkey] = useState('Ctrl + Shift + Space')
  const [queued, setQueued] = useState<SelectionSnapshot>()
  const lastSelection = useRef(0)
  const sequence = useRef(0)
  const latest = useRef({ busy, question, useAi })
  latest.current = { busy, question, useAi }
  const active = frames.at(-1)

  useEffect(() => {
    let disposed = false
    void api().configGet().then((config) => {
      if (!disposed) { setAutomatic(config.term.selectionAuto); setHotkey(config.term.selectionHotkey.replace('Control', 'Ctrl').replaceAll('+', ' + ')) }
    }).catch((failure) => { if (!disposed) setError(errorText(failure)) })
    const timer = setInterval(() => {
      void api().selectionGet().then((selection) => {
        if (disposed || !selection.id || selection.id === lastSelection.current) return
        lastSelection.current = selection.id
        if (latest.current.busy || latest.current.question.trim()) { setQueued(selection); return }
        void accept(selection)
      }).catch((failure) => { if (!disposed) setError(errorText(failure)) })
    }, 350)
    return () => { disposed = true; clearInterval(timer) }
  }, [])

  async function accept(selection: SelectionSnapshot): Promise<void> {
    setQueued(undefined)
    setFrames([])
    setQuestion('')
    setText(selection.text)
    setEditing(false)
    setTerms([])
    setError(selection.error ?? '')
    if (selection.text) await analyze(selection.text, true)
  }

  async function analyze(source = text, save = false): Promise<void> {
    if (!source.trim()) return
    const run = ++sequence.current
    setBusy(true)
    setError('')
    try {
      if (save) await api().readerSave({ title: source.trim().slice(0, 60), text: source })
      const result = await api().termDetect({ text: source, useAi: latest.current.useAi })
      if (run !== sequence.current) return
      setTerms(result.terms)
      if (result.warning) setError(result.warning)
      if (source.trim().length <= 100) {
        const trimmed = source.trim()
        const term = result.terms.find((item) => item.surface === trimmed) ?? {
          id: `selection_${Date.now()}`, surface: trimmed, canonical: trimmed, domain: 'general',
          range: [source.indexOf(trimmed), source.indexOf(trimmed) + trimmed.length] as [number, number], confidence: 1, source: 'llm' as const
        }
        const opened = await api().termDetail({ term })
        if (run === sequence.current) setFrames([{ ...opened, term }])
      }
    } catch (failure) { if (run === sequence.current) setError(errorText(failure)) }
    finally { if (run === sequence.current) setBusy(false) }
  }

  async function open(term: Term, parents: Frame[] = []): Promise<void> {
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
      <header className="quick-header"><strong>TermLens</strong><div><button onClick={() => void api().selectionOpenManager()}>记录与设置</button><button onClick={() => void api().selectionHide()}>收起</button></div></header>
      <div className="quick-controls">
        <label><input type="checkbox" checked={automatic} onChange={(event) => void toggleAutomatic(event.target.checked)} />选中即解释</label>
        <label><input type="checkbox" checked={useAi} onChange={(event) => setUseAi(event.target.checked)} />AI 分词</label>
      </div>
      {queued && <div className="quick-queued"><span>有新的选中文字</span><button disabled={busy} onClick={() => void accept(queued)}>打开</button></div>}
      <section className="quick-input">
        {editing ? <><label htmlFor="quick-text">文字</label><textarea id="quick-text" value={text} disabled={busy} maxLength={16000} rows={3} onChange={(event) => { sequence.current++; setText(event.target.value); setTerms([]); setFrames([]) }} /><button disabled={busy || !text.trim()} onClick={() => { setEditing(false); void analyze(text, true) }}>解释</button></> : <>
          {text ? <div className="quick-annotated">{annotated()}</div> : <div className="quick-empty"><h1>选中，就在这里解释</h1><p>在其他软件里选中文字，按 <kbd>{hotkey}</kbd>。</p><p>开启“选中即解释”后，选择文字就会弹出浮窗。无需先把文章输入到这里。</p></div>}
          <button disabled={busy} onClick={() => setEditing(true)}>{text ? '编辑文字' : '粘贴文字'}</button>
        </>}
        {busy && <span role="status">处理中</span>}
      </section>
      {error && <Notice error>{error}</Notice>}
      {frames.length > 0 && <nav className="quick-breadcrumb" aria-label="概念路径">{frames.map((frame, index) => <button key={frame.thread.threadId} disabled={busy} onClick={() => { setFrames(frames.slice(0, index + 1)); setQuestion('') }}>{frame.term.canonical}</button>)}</nav>}
      {active && <section className="quick-detail">
        <h1>{active.term.canonical}</h1><span className="source-label">{active.explanation.source === 'lexicon' ? '本地词库' : active.explanation.source === 'cache' ? '本地缓存' : 'AI 生成'}</span>
        <p>{active.explanation.detail?.definition ?? active.explanation.brief}</p>
        {active.explanation.detail?.background && <p>{active.explanation.detail.background}</p>}
        {!!active.explanation.detail?.keyPoints.length && <ul>{active.explanation.detail.keyPoints.map((point, index) => <li key={index}>{point}</li>)}</ul>}
        <div className="quick-related">{active.explanation.detail?.related.map((canonical) => <button disabled={busy} key={canonical} onClick={() => {
          void api().termDetect({ text: canonical }).then((result) => open(result.terms.find((term) => term.canonical === canonical) ?? { id: `related_${Date.now()}`, canonical, surface: canonical, domain: 'general', range: [0, canonical.length], confidence: 1, source: 'llm' }, frames)).catch((failure) => setError(errorText(failure)))
        }}>{canonical}</button>)}</div>
        <div className="quick-messages" aria-live="polite">{active.thread.messages.map((message) => <article key={message.id} className={message.role}><strong>{message.role === 'user' ? '我的追问' : '回答'}</strong><p>{message.content}</p></article>)}</div>
        <form className="quick-question" onSubmit={(event) => { event.preventDefault(); void ask() }}><label htmlFor="quick-question">继续追问</label><textarea id="quick-question" value={question} disabled={busy} maxLength={4000} rows={2} onChange={(event) => setQuestion(event.target.value)} /><button disabled={busy || !question.trim()} type="submit">发送</button></form>
      </section>}
    </div>
  )
}
