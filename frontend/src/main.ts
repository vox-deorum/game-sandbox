/**
 * The frontend entrypoint: the client router, the Vue app, and the page routes. Identity is the Better
 * Auth session cookie; the app shell fetches `GET /api/me` once through the `me.ts` provider so the
 * header and the pages share one answer for who-am-I and what-may-I-do, and `/login` establishes that
 * session. Pages self-gate on the `me` answer (as the admin console does), so there is no router guard
 * and anonymous browsing of public pages works unchanged.
 *
 * Routing is vue-router in plain library mode: `/` (home), `/login`, `/environments/:envId`,
 * `/sessions/:id` (live), and `/replays/:id` (replay). The renderer modules register themselves on
 * import; importing the registry barrel here is where future environments' renderers get pulled in.
 */
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'

import App from './App.vue'
import { loadSiteConfig } from './composables/useSiteConfig.js'
import AdminConsolePage from './pages/AdminConsolePage.vue'
import AdminLogsPage from './pages/AdminLogsPage.vue'
import AgentProfilePage from './pages/AgentProfilePage.vue'
import DocsPage from './pages/DocsPage.vue'
import EnvironmentPage from './pages/EnvironmentPage.vue'
import HomePage from './pages/HomePage.vue'
import LeaderboardsPage from './pages/LeaderboardsPage.vue'
import LoginPage from './pages/LoginPage.vue'
import MyAgentsPage from './pages/MyAgentsPage.vue'
import ProfilePage from './pages/ProfilePage.vue'
import ReplayPage from './pages/ReplayPage.vue'
import ReplaysPage from './pages/ReplaysPage.vue'
import RunDetailsPage from './pages/RunDetailsPage.vue'
import SeasonsPage from './pages/SeasonsPage.vue'
import SessionPage from './pages/SessionPage.vue'
import UsersAdminPage from './pages/UsersAdminPage.vue'
import './renderers/index.js'
// Style layers in order: tokens, reset, the app shell layout, then shared season rows. Other component
// styling lives in scoped CSS on the tokens (see plans/stage-04.5/design-foundation.md).
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import './styles/season-rows.css'
// The highlight.js token colors for fenced code in the in-app docs. The renderer already emits
// `hljs-*` token spans (see docs/markdown.ts); this theme is what gives them color. `github-dark`'s
// near-black background matches the ink surface, and DocsMarkdown's scoped `pre.hljs` rule keeps the
// app's own code-box background, so only the tokens inside pick up the theme.
import 'highlight.js/styles/github-dark.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: HomePage },
    // The sign-in page. Anonymous browsing is allowed everywhere, so this is a normal route rather
    // than a guard target; the request() 401 interceptor and signed-out affordances link here.
    { path: '/login', component: LoginPage },
    // Global, cross-game sections in the sidebar. Seasons uses the public cross-game season index;
    // My Agents aggregates the signed-in user's profiles. Documentation renders the student guides:
    // /docs is the landing and the catch-all carries a guide's docs-relative path (students/...).
    { path: '/seasons', component: SeasonsPage },
    { path: '/docs', component: DocsPage },
    { path: '/docs/:docPath(.*)', component: DocsPage },
    { path: '/my/agents', component: MyAgentsPage },
    { path: '/my/profile', component: ProfilePage },
    // The operator roster page: lists, searches, and pages every account through the Better Auth
    // admin plugin. Like the admin console it self-gates on `isAdmin(me)`; the backend admin API
    // (the plugin's custom-role permission check) is the real authority.
    { path: '/admin/users', component: UsersAdminPage },
    { path: '/admin/logs', component: AdminLogsPage },
    { path: '/environments/:envId', component: EnvironmentPage },
    { path: '/environments/:envId/agents/:ownerId', component: AgentProfilePage },
    // The per-environment, per-season Leaderboards page; the season id is optional and defaults
    // to the current released season, so a specific season's boards are shareable by URL.
    { path: '/environments/:envId/leaderboards/:seasonId?', component: LeaderboardsPage },
    // The per-environment Replays tab: the environment's recordings as a sortable table.
    { path: '/environments/:envId/replays', component: ReplaysPage },
    // The operator admin console. The page itself gates on `isAdmin(me)` (and the backend admin API
    // is the real authority), so a non-admin who reaches the route sees an access notice.
    { path: '/environments/:envId/admin', component: AdminConsolePage },
    // The operator run-details page: one run's games and live container-log stream, linked from the
    // console's runs list. Like the console it self-gates on `isAdmin(me)`; the backend is the
    // real authority. The season and run ids drive the admin run-detail read and its log socket.
    {
      path: '/environments/:envId/admin/seasons/:seasonId/runs/:runId',
      component: RunDetailsPage,
    },
    { path: '/sessions/:id', component: SessionPage },
    { path: '/replays/:id', component: ReplayPage },
  ],
})

// The styleguide (every primitive in every variant, see frontend/design-system.md) exists only in dev: the DEV
// guard is compile-time false in production, so the route and the dynamically imported page are
// dead code there and the bundle carries neither.
if (import.meta.env.DEV) {
  router.addRoute({ path: '/styleguide', component: () => import('./pages/StyleguidePage.vue') })
}

const root = document.getElementById('app')
if (root === null) {
  throw new Error('missing #app element')
}
// Fetch the deployment brand once (sidebar + document title); fire-and-forget, the default renders first.
void loadSiteConfig()
createApp(App).use(router).mount(root)
