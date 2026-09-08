import { Fragment, useEffect, useRef, useState } from 'react'
import type { SourceDocument, SourceSegment, SourceStatus, SourceSummary } from '@shared/types/source'
import { api, errorText, Notice } from './ui'

export function SourcesPage(): JSX.Element {
  const [items, setItems] = useState<SourceSummary[]>([])
  const [source, setSource] = useState<SourceDocument>()
  const [status, setStatus] = useState<SourceStatus>({ paused: false, tasks: [] })
  const [location, setLocation] = useState('')
  const [question, setQuestion] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [useAi, setUseAi] = useState(false)
  const [segmentId, setSegmentId] = useState('')
  const currentId = useRef<string>()
  const seen = useRef('')
  const selectionVersion = useRef(0)
  const pendingRead = useRef<string>()

  useEffect(() => {
    let stopped = false
    let polling = false
    async function refresh(): Promise<void> {
      if (polling) return
      polling = true
      try {
        const next = await api().sourceStatus()
        if (stopped) return
        setStatus(next)
        const signature = JSON.stringify(next.tasks.map((task) => [task.id, task.state, task.progress, task.sourceId]))
        if (signature !== seen.current || seen.current === '') {
          seen.current = signature
          const list = await api().sourceList()
          if (stopped) return
          setItems(list)
          const pending = next.tasks.find((task) => task.id === pendingRead.current)
          if (pending?.state === 'complete') { currentId.current = pending.sourceId; pendingRead.current = undefined }
          if (pending && ['failed', 'cancelled'].includes(pending.state)) pendingRead.current = undefined
          const id = currentId.current
          if (id) {
            const version = selectionVersion.current
            const document = await api().sourceGet(id)
            if (!stopped && version === selectionVersion.current) setSource(document)
          }
        }
      } catch (cause) { if (!stopped) setError(errorText(cause)) }
      finally { polling = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 700)
    return () => { stopped = true; clearInterval(timer) }
  }, [])

  async function run(action: () => Promise<unknown>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    try { await action() } catch (cause) { setError(errorText(cause)) }
    finally { setBusy(false) }
  }

  async function open(id: string): Promise<void> {
    const version = ++selectionVersion.current
    pendingRead.current = undefined
    currentId.current = id
    setQuestion('')
    setSegmentId('')
    const document = await api().sourceGet(id)
    if (selectionVersion.current === version) setSource(document)
  }

  async function add(value = location): Promise<void> {
    const normalized = value.trim()
    if (!normalized) return
    const task = await api().sourceImport({ kind: /^https?:\/\//i.test(normalized) ? 'url' : 'file', location: normalized })
    pendingRead.current = task.id
    ++selectionVersion.current
    currentId.current = undefined
    setSource(undefined)
    setQuestion('')
    setSegmentId('')
    setLocation('')
  }

  function jump(id: string): void {
    setSegmentId(id)
    document.getElementById(`source-segment-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function ask(term?: string, segment?: SourceSegment): Promise<void> {
    if (!source) return
    await api().sourceAsk({ id: source.id, question: term ? `结合原文解释“${term}”，说明含义并给出一个例子。` : question.trim(), term, segmentId: segment?.id || segmentId || undefined })
    if (segment) setSegmentId(segment.id)
    if (!term) setQuestion('')
  }

  function marked(segment: SourceSegment): React.ReactNode {
    let offset = 0
    const content: React.ReactNode[] = []
    for (const term of segment.terms ?? []) {
      const [start, end] = term.range
      if (start < offset || end > segment.text.length || segment.text.slice(start, end) !== term.surface) continue
      content.push(<Fragment key={`${term.id}-${start}`}>{segment.text.slice(offset, start)}<button className="term-mark" disabled={busy || sourceBusy || status.paused} onClick={() => void run(() => ask(term.surface, segment))}>{term.surface}</button></Fragment>)
      offset = end
    }
    content.push(segment.text.slice(offset))
    return content
  }

  const sourceBusy = status.tasks.some((task) => task.sourceId === source?.id && ['running', 'queued'].includes(task.state))
  const activeTasks = status.tasks.filter((task) => ['running', 'queued'].includes(task.state))
  return <div className="sources-page">
    <header className="page-toolbar"><h1>资料阅读</h1><button className="button-secondary" disabled={busy} onClick={() => void run(async () => setStatus(await api().sourcePause({ paused: !status.paused })))}>{status.paused ? '继续助手' : '暂停助手'}</button></header>
    <div className="sources-intro"><p>加入文件或网址，在后台读取。术语解释和追问保留原文出处。</p><p className="muted">读取当前软件：切到正文，按 <kbd>Ctrl + Shift + R</kbd>，保持窗口不变直到读取完成，再回到这里查看。窗口读取只包含软件提供的文字，不代表全文。</p></div>
    {error && <Notice error>{error}</Notice>}
    {status.paused && <Notice>助手已暂停：新资料任务等待处理，正在进行的任务已停止，自动选词监听暂停。已保存内容仍可查看。</Notice>}
    <form className="source-import" onSubmit={(event) => { event.preventDefault(); void run(() => add()) }}>
      <button type="button" className="button-secondary" disabled={busy} onClick={() => void run(async () => { const path = await api().sourcePickFile(); if (path) await add(path) })}>选择文件</button>
      <input aria-label="资料网址或文件路径" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="粘贴 https:// 网址或本机文件完整路径" maxLength={4000} />
      <button className="button-primary" disabled={busy || !location.trim()}>开始读取</button>
    </form>
    <p className="sources-formats muted">文件：TXT、Markdown、CSV、HTML、DOCX、XLSX、PPTX、PDF、SRT/VTT 字幕。图片与扫描页暂不做文字识别；网页仅读取可获取内容。</p>
    {status.tasks.length > 0 && <section className="source-tasks" aria-label="后台任务"><h2>后台任务{activeTasks.length ? ` · ${activeTasks.length} 项待完成` : ''}</h2>{status.tasks.slice(-6).reverse().map((task) => <div key={task.id} className="source-task"><div><strong>{task.title}</strong><span role="status">{task.state === 'queued' ? '等待处理' : task.state === 'running' ? task.progress : task.state === 'complete' ? '已完成' : task.state === 'cancelled' ? '已停止' : task.error || '处理失败'}</span></div>{['running', 'queued'].includes(task.state) ? <button className="text-button" onClick={() => void run(() => api().sourceCancel(task.id))}>停止</button> : task.sourceId && <button className="text-button" onClick={() => void run(() => open(task.sourceId!))}>查看</button>}</div>)}</section>}
    <div className="sources-workspace">
      <aside className="sources-library" aria-label="资料列表"><h2>我的资料</h2>{!items.length && <p className="muted">加入第一份资料开始阅读。</p>}{items.map((item) => <button key={item.id} className="source-item" aria-pressed={source?.id === item.id} onClick={() => void run(() => open(item.id))}><strong>{item.title}</strong><span>{item.format} · {item.segmentCount} 段 · {item.coverage === 'partial' ? '部分读取' : '文本已提取'}</span></button>)}</aside>
      {source ? <div className="source-document">
        <div className="source-title"><h2>{source.title}</h2><button className="text-button danger-text" disabled={busy || sourceBusy} onClick={() => {
          if (!window.confirm('删除这份资料及其对话？原始文件不受影响。')) return
          void run(async () => { await api().sourceDelete(source.id); ++selectionVersion.current; currentId.current = undefined; setSource(undefined); setItems(await api().sourceList()) })
        }}>删除资料</button></div>
        <p className="source-coverage">{source.coverage === 'complete' ? '文本提取已完成' : '部分读取'} · {source.segments.length} 段 · {source.segments.reduce((sum, segment) => sum + segment.text.length, 0).toLocaleString()} 字符</p>
        <p>{source.coverageNote}</p>
        {source.warnings.map((warning, index) => <Notice key={index}>{warning}</Notice>)}
        <div className="source-analysis"><label className="checkbox-label"><input type="checkbox" checked={useAi} disabled={sourceBusy} onChange={(event) => setUseAi(event.target.checked)} />使用 AI 识别术语</label><button className="button-secondary" disabled={busy || sourceBusy || status.paused} onClick={() => void run(() => api().sourceAnalyze({ id: source.id, useAi }))}>识别全部段落术语</button>{source.kind !== 'window' && <button className="text-button" onClick={() => void run(() => api().sourceOpenLocation({ id: source.id }))}>{source.kind === 'file' ? '定位原文件' : '打开原网页'}</button>}</div>
        <p className="muted">AI 已分析 {source.analyzedSegmentIds.length}/{source.segments.length} 段。{useAi ? '识别会分段发送给已配置的模型，按服务计费；可随时停止，已完成段落保留。' : '本地识别无需发送原文；点击术语解释或追问时，会把问题和相关片段发给已配置的模型。'}</p>
        <p className="muted">为保持阅读流畅，每段最多标出 100 处术语，每份资料最多 2,000 处；其余文字仍可在提问框中询问。</p>
        <div className="source-content-grid"><div className="source-segments" aria-label="资料正文">{source.segments.map((segment) => <section id={`source-segment-${segment.id}`} key={segment.id} className={`source-segment${segmentId === segment.id ? ' selected' : ''}`}><div className="section-heading"><h3>{segment.label}</h3><button className="text-button" aria-pressed={segmentId === segment.id} onClick={() => setSegmentId(segmentId === segment.id ? '' : segment.id)}>围绕此段提问</button></div><p>{marked(segment)}</p>{segment.startSeconds !== undefined && source.kind === 'video' && <button className="text-button" onClick={() => void run(() => api().sourceOpenLocation({ id: source.id, segmentId: segment.id }))}>跳到视频此处</button>}</section>)}</div>
          <aside className="source-conversation" aria-label="资料问答"><h2>结合原文追问</h2><p className="muted">从整份已提取资料中查找相关片段回答。资料未包含的内容会明确说明。</p>{source.messages.map((message) => <article className={`message message-${message.role}`} key={message.id}><strong>{message.role === 'user' ? '我的问题' : '回答'}</strong><p>{message.content}</p>{message.error && <Notice error>{message.error}</Notice>}<div className="source-citations">{message.citations.map((citation) => <button key={citation.segmentId} className="text-button" onClick={() => jump(citation.segmentId)}>{citation.label}</button>)}</div></article>)}
            <form className="question-form" onSubmit={(event) => { event.preventDefault(); void run(() => ask()) }}><label htmlFor="source-question">{segmentId ? `当前依据：${source.segments.find((segment) => segment.id === segmentId)?.label}` : '向这份资料提问'}</label><textarea id="source-question" maxLength={4000} value={question} disabled={busy || sourceBusy} onChange={(event) => setQuestion(event.target.value)} placeholder="这个概念是什么意思？它和前面一章有什么关系？" /><div className="question-actions"><button type="submit" className="button-primary" disabled={busy || sourceBusy || status.paused || !question.trim()}>发送问题</button>{segmentId && <button type="button" className="text-button" onClick={() => setSegmentId('')}>取消指定段落</button>}</div></form>
          </aside></div>
      </div> : <div className="source-welcome"><h2>原文、概念和问题放在一起</h2><p>后台任务完成后，在这里打开资料。读取范围会明确显示，不会把未获取的页面当作已经读完。</p></div>}
    </div>
  </div>
}
