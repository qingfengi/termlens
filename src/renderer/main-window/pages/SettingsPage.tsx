import { useEffect, useState } from 'react'
import type { AppSettingsParsed } from '@shared/config/schema'
import type { ProviderConfig, ProviderProtocol } from '@shared/types/provider'
import { api, errorText, Notice } from './ui'

const ENDPOINTS: Record<ProviderProtocol, string> = {
  openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com/v1beta'
}
const PROTOCOLS: Record<ProviderProtocol, string> = { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini' }

function editable(provider: ProviderConfig): ProviderConfig {
  return { ...provider, apiKey: '' }
}

export function SettingsPage(): JSX.Element {
  const [config, setConfig] = useState<AppSettingsParsed>()
  const [draft, setDraft] = useState<ProviderConfig>()
  const [baseline, setBaseline] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [models, setModels] = useState<Array<{ id: string; name?: string }>>()
  const selected = config?.providers.find((provider) => provider.id === draft?.id)
  const dirty = Boolean(draft && (JSON.stringify(draft) !== baseline || clearKey))

  function choose(provider?: ProviderConfig): void {
    const next = provider && editable(provider)
    setDraft(next)
    setBaseline(next ? JSON.stringify(next) : '')
    setClearKey(false)
    setError('')
    setNotice('')
    setModels(undefined)
  }

  async function load(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const next = await api().configGet()
      setConfig(next)
      choose(next.providers[0])
    } catch (cause) { setError(errorText(cause)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  function canSwitch(): boolean {
    return !dirty || window.confirm('服务配置尚未保存。放弃本次修改？')
  }

  function addProvider(): void {
    if (!canSwitch()) return
    const next: ProviderConfig = {
      id: crypto.randomUUID(), name: '', protocol: 'openai', baseUrl: ENDPOINTS.openai,
      apiKey: '', model: '', timeoutMs: 60000, maxRetries: 2
    }
    setDraft(next)
    setBaseline('')
    setClearKey(false)
    setError('')
    setNotice('')
    setModels(undefined)
  }

  function changeConnection(patch: Partial<ProviderConfig>): void {
    if (!draft) return
    setDraft({ ...draft, ...patch })
    setModels(undefined)
    setNotice('')
    setError('')
  }

  async function fetchModels(): Promise<void> {
    if (!draft || busy) return
    setBusy('models')
    setError('')
    setNotice('')
    setModels(undefined)
    try {
      const result = await api().providerModels({
        id: selected?.id, protocol: draft.protocol, baseUrl: draft.baseUrl.trim(),
        apiKey: clearKey ? '' : draft.apiKey || selected?.apiKey || ''
      })
      setDraft({ ...draft, baseUrl: result.baseUrl })
      setModels(result.models)
      setNotice(result.models.length ? `已获取 ${result.models.length} 个模型，请选择适合文字解释的模型。选好保存后可测试连接。` : '服务没有返回可选模型，仍可手动填写模型名称。')
    } catch (cause) { reportError(cause) }
    finally { setBusy('') }
  }

  function reportError(cause: unknown): void {
    const message = errorText(cause)
    setError(draft?.apiKey ? message.replaceAll(draft.apiKey, '[已隐藏]') : message)
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!draft || busy) return
    setBusy('save')
    setError('')
    setNotice('')
    try {
      const next = await api().providerUpsert({
        ...draft, name: draft.name.trim(), model: draft.model.trim(), baseUrl: draft.baseUrl.trim(),
        apiKey: clearKey ? '' : draft.apiKey || selected?.apiKey || ''
      })
      setConfig(next)
      choose(next.providers.find((provider) => provider.id === draft.id))
      setNotice('服务配置已保存')
    } catch (cause) { reportError(cause) }
    finally { setBusy('') }
  }

  async function testConnection(): Promise<void> {
    if (!selected || dirty || busy) return
    setBusy('test')
    setError('')
    setNotice('')
    try {
      const result = await api().providerTest(selected.id)
      if (!result.ok) throw new Error(result.error || '连接失败，请检查地址、模型和密钥。')
      setNotice(`连接成功${result.model ? ` · ${result.model}` : ''}${result.latencyMs !== undefined ? ` · ${Math.round(result.latencyMs)} ms` : ''}`)
    } catch (cause) { reportError(cause) }
    finally { setBusy('') }
  }

  async function removeProvider(): Promise<void> {
    if (!selected || busy || !window.confirm(`删除服务“${selected.name}”及其已保存密钥？`)) return
    setBusy('remove')
    setError('')
    setNotice('')
    try {
      const next = await api().providerRemove(selected.id)
      setConfig(next)
      choose(next.providers[0])
      setNotice('服务已删除')
    } catch (cause) { reportError(cause) }
    finally { setBusy('') }
  }

  async function bindProvider(id: string): Promise<void> {
    if (!config || busy) return
    setBusy('binding')
    setError('')
    setNotice('')
    try {
      const featureBindings = { ...config.featureBindings }
      for (const feature of ['termBrief', 'termDetail', 'termFollowup']) {
        featureBindings[feature] = id
      }
      setConfig(await api().configUpdate({ featureBindings }))
      setNotice('术语默认服务已保存')
    } catch (cause) { reportError(cause) }
    finally { setBusy('') }
  }

  return (
    <div className="settings-page">
      <header className="page-toolbar"><h1>设置</h1><button type="button" className="button-secondary" disabled={loading || Boolean(busy)} onClick={addProvider}>添加 AI 服务</button></header>
      <div className="settings-content">
        {loading && <p className="muted" role="status">正在读取设置…</p>}
        {error && <Notice error>{error}{!config && <button type="button" className="text-button" onClick={() => void load()}>重新读取</button>}</Notice>}
        {notice && <Notice>{notice}</Notice>}
        {config && <>
          <section className="default-provider"><h2>术语默认服务</h2><select aria-label="术语默认服务" value={config.featureBindings.termDetail ?? ''} disabled={Boolean(busy) || config.providers.length === 0} onChange={(event) => void bindProvider(event.target.value)}><option value="">{config.providers.length ? '自动选择首个服务' : '尚未配置 AI 服务'}</option>{config.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select></section>
          <section className="default-provider"><h2>概念嵌套</h2><label className="field"><span>最大嵌套层数 <small>默认 10，范围 1—20</small></span><input aria-label="最大嵌套层数" type="number" min={1} max={20} step={1} value={config.term.maxNestedDepth} disabled={Boolean(busy)} onChange={(event) => { const value = Math.max(1, Math.min(20, Number(event.target.value))); setConfig({ ...config, term: { ...config.term, maxNestedDepth: value } }); void api().configUpdate({ term: { maxNestedDepth: value } }) }} /></label><p className="muted">AI 生成的相关概念也可以继续展开；达到上限后停止继续请求。</p></section>
          <section className="default-provider"><h2>术语速度</h2><label className="checkbox-label"><input type="checkbox" checked={config.term.speedMode} disabled={Boolean(busy)} onChange={(event) => { const speedMode = event.target.checked; setConfig({ ...config, term: { ...config.term, speedMode } }); void api().configUpdate({ term: { speedMode } }) }} />只分词模式启用并发预取</label><label className="field"><span>并发请求数 <small>1—8，默认 3</small></span><input aria-label="术语并发请求数" type="number" min={1} max={8} step={1} value={config.term.speedConcurrency} disabled={Boolean(busy) || !config.term.speedMode} onChange={(event) => { const speedConcurrency = Math.max(1, Math.min(8, Number(event.target.value) || 1)); setConfig({ ...config, term: { ...config.term, speedConcurrency } }); void api().configUpdate({ term: { speedConcurrency } }) }} /></label><p className="muted">独立术语可并行请求；整段解释始终保持一次请求，避免失去上下文。</p></section>
          <div className="provider-workspace">
            <section className="provider-list" aria-label="AI 服务列表"><div className="section-heading"><h2>AI 服务</h2><span className="muted">{config.providers.length}</span></div>
              {config.providers.length === 0 && <p className="empty-line">暂无已保存的服务</p>}
              {config.providers.map((provider) => <button type="button" key={provider.id} className={`provider-row${draft?.id === provider.id ? ' is-selected' : ''}`} aria-pressed={draft?.id === provider.id} disabled={Boolean(busy)} onClick={() => { if (canSwitch()) choose(provider) }}><strong>{provider.name}</strong><span>{PROTOCOLS[provider.protocol]} · {provider.model}</span></button>)}
            </section>
            {draft ? <form className="provider-form" onSubmit={(event) => void save(event)} autoComplete="off">
              <div className="section-heading"><h2>{selected ? '编辑服务' : '新建服务'}</h2><span className={`save-state${dirty ? ' is-dirty' : ''}`}>{dirty ? '未保存' : '已保存'}</span></div>
              <fieldset disabled={Boolean(busy)}>
                <label className="field"><span>服务名称</span><input aria-label="服务名称" value={draft.name} maxLength={100} required placeholder="例如：我的模型服务" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label className="field"><span>连接协议</span><select aria-label="连接协议" value={draft.protocol} onChange={(event) => { const protocol = event.target.value as ProviderProtocol; changeConnection({ protocol, baseUrl: Object.values(ENDPOINTS).includes(draft.baseUrl) ? ENDPOINTS[protocol] : draft.baseUrl }) }}>{Object.entries(PROTOCOLS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label className="field"><span>服务地址</span><input aria-label="服务地址" type="url" value={draft.baseUrl} required spellCheck={false} placeholder="https://" onChange={(event) => changeConnection({ baseUrl: event.target.value })} /></label>
                <label className="field"><span>API 密钥 <small>{selected?.apiKey ? '已保存' : '可留空'}</small></span><input aria-label="API 密钥" type="password" autoComplete="new-password" spellCheck={false} disabled={clearKey} value={draft.apiKey} placeholder={selected?.apiKey ? '留空保留现有密钥' : '输入密钥'} onChange={(event) => changeConnection({ apiKey: event.target.value })} /></label>
                {selected?.apiKey && <label className="checkbox-label clear-key"><input type="checkbox" checked={clearKey} onChange={(event) => { setClearKey(event.target.checked); setModels(undefined); setNotice('') }} />移除已保存的密钥</label>}
                <div className="model-discovery"><button type="button" className="button-secondary" disabled={!draft.baseUrl.trim()} onClick={() => void fetchModels()}>{busy === 'models' ? '正在获取模型…' : '获取模型列表'}</button><p className="muted">填写地址和密钥即可获取，无需先保存。服务不支持时可手动填写。</p></div>
                {Boolean(models?.length) && <label className="field"><span>可用模型</span><select aria-label="可用模型" value={models?.some((model) => model.id === draft.model) ? draft.model : ''} onChange={(event) => { if (event.target.value) setDraft({ ...draft, model: event.target.value }) }}><option value="">请选择模型</option>{models?.map((model) => <option key={model.id} value={model.id}>{model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}</option>)}</select></label>}
                <label className="field"><span>模型名称 <small>可从列表选择，也可手动填写</small></span><input aria-label="模型名称" value={draft.model} required spellCheck={false} maxLength={200} placeholder="填写服务提供的模型名称" onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
                <details className="request-options"><summary>请求设置</summary><div className="field-grid"><label className="field"><span>超时（秒）</span><input aria-label="超时秒数" type="number" min={1} max={600} step={1} required value={draft.timeoutMs / 1000} onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) * 1000 })} /></label><label className="field"><span>失败重试次数</span><input aria-label="失败重试次数" type="number" min={0} max={10} step={1} required value={draft.maxRetries} onChange={(event) => setDraft({ ...draft, maxRetries: Number(event.target.value) })} /></label></div></details>
                <div className="provider-actions"><button type="submit" className="button-primary" disabled={!dirty}>{busy === 'save' ? '正在保存…' : '保存服务'}</button><button type="button" className="button-secondary" disabled={!selected || dirty} title={dirty ? '保存修改后可测试连接' : '测试已保存的连接'} onClick={() => void testConnection()}>{busy === 'test' ? '正在测试…' : '测试连接'}</button>{selected && <button type="button" className="text-button danger-text" onClick={() => void removeProvider()}>删除服务</button>}</div>
              </fieldset>
            </form> : <div className="provider-empty"><p>尚未选择服务</p><button type="button" className="button-secondary" onClick={addProvider}>添加 AI 服务</button></div>}
          </div>
        </>}
      </div>
    </div>
  )
}
