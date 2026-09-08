import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ReaderPage, SettingsPage } from './pages'
import type {} from '@shared/ipc/api'
import { QuickPage } from './pages/QuickPage'
import { SourcesPage } from './pages/SourcesPage'

export default function App(): JSX.Element {
  const { pathname } = useLocation()
  if (pathname === '/quick') return <QuickPage />
  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/reader" className="brand" aria-label="TermLens 阅读器">TermLens</NavLink>
        <nav className="app-nav" aria-label="主导航">
          <NavLink to="/reader">阅读器</NavLink>
          <NavLink to="/sources">资料阅读</NavLink>
          <NavLink to="/settings">设置</NavLink>
        </nav>
      </header>
      <main className="app-main">
        <div hidden={pathname !== '/reader'} className="reader-route"><ReaderPage /></div>
        <Routes>
          <Route path="/reader" element={null} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="*" element={<Navigate to="/reader" replace />} />
        </Routes>
      </main>
    </div>
  )
}
