/**
 * The frontend entrypoint: the client router, the Vue app, and the page routes. Identity is the mock
 * auto-logon resolved in `identity.ts`; the app shell fetches `GET /api/me` once through the `me.ts`
 * provider so the header and the pages share one answer for who-am-I and what-may-I-do.
 *
 * Routing is vue-router in plain library mode: `/` (home), `/environments/:envId`, `/sessions/:id`
 * (live), and `/replays/:id` (replay). The renderer modules register themselves on import; importing
 * the registry barrel here is where future environments' renderers get pulled in.
 */
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'

import App from './App.vue'
import EnvironmentPage from './pages/EnvironmentPage.vue'
import HomePage from './pages/HomePage.vue'
import ReplayPage from './pages/ReplayPage.vue'
import SessionPage from './pages/SessionPage.vue'
import './renderers/index.js'
// Style layers in order: tokens, reset, then the app shell layout. Component styling lives in scoped
// component CSS on the tokens (see plans/stage-04.5/design-foundation.md); the global sheet carries
// only these three layers now that every page has migrated off the transitional stylesheet.
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: HomePage },
    { path: '/environments/:envId', component: EnvironmentPage },
    { path: '/sessions/:id', component: SessionPage },
    { path: '/replays/:id', component: ReplayPage },
  ],
})

// The styleguide (every primitive in every variant, see design.md) exists only in dev: the DEV
// guard is compile-time false in production, so the route and the dynamically imported page are
// dead code there and the bundle carries neither.
if (import.meta.env.DEV) {
  router.addRoute({ path: '/styleguide', component: () => import('./pages/StyleguidePage.vue') })
}

const root = document.getElementById('app')
if (root === null) {
  throw new Error('missing #app element')
}
createApp(App).use(router).mount(root)
