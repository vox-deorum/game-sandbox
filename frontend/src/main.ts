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
import EnvironmentPage from './pages/environment.vue'
import HomePage from './pages/home.vue'
import ReplayPage from './pages/replay.vue'
import SessionPage from './pages/session.vue'
import './renderers/index.js'
import './styles.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: HomePage },
    { path: '/environments/:envId', component: EnvironmentPage },
    { path: '/sessions/:id', component: SessionPage },
    { path: '/replays/:id', component: ReplayPage },
  ],
})

const root = document.getElementById('app')
if (root === null) {
  throw new Error('missing #app element')
}
createApp(App).use(router).mount(root)
