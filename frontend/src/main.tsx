/**
 * The frontend entrypoint: the client router, the app shell (the header with the site name and the
 * signed-in user), and the page routes. Identity is the mock auto-logon resolved in `identity.ts`;
 * the shell fetches `GET /api/me` once through {@link MeProvider} so the header and the pages share
 * one answer for who-am-I and what-may-I-do.
 *
 * Routing is react-router in plain library mode: `/` (home), `/environments/:envId`, `/sessions/:id`
 * (live), and `/replays/:id` (replay). The renderer modules register themselves on import; importing
 * the registry barrel here is where future environments' renderers get pulled in.
 */
import { type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Outlet, Route, Routes } from 'react-router'

import { currentUserId } from './identity.js'
import { MeProvider, useMe } from './me.js'
import { EnvironmentPage } from './pages/environment.js'
import { HomePage } from './pages/home.js'
import { ReplayPage } from './pages/replay.js'
import { SessionPage } from './pages/session.js'
import './renderers/index.js'
import './styles.css'

function SignedInUser(): ReactNode {
  const { me, loading } = useMe()
  // While /api/me is in flight, fall back to the locally resolved id so the header never flickers.
  const user = me?.user_id ?? currentUserId
  return <span className="signed-in">{loading ? 'signing in…' : `signed in as ${user}`}</span>
}

function AppShell(): ReactNode {
  return (
    <div className="app">
      <header className="app-header">
        <Link className="site-name" to="/">
          Game Sandbox
        </Link>
        <SignedInUser />
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}

function App(): ReactNode {
  return (
    <BrowserRouter>
      <MeProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/environments/:envId" element={<EnvironmentPage />} />
            <Route path="/sessions/:id" element={<SessionPage />} />
            <Route path="/replays/:id" element={<ReplayPage />} />
          </Route>
        </Routes>
      </MeProvider>
    </BrowserRouter>
  )
}

const root = document.getElementById('root')
if (root === null) {
  throw new Error('missing #root element')
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
