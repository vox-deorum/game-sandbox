# frontend/

The Game Sandbox web app: Vue 3 with Vite and TypeScript, served on one origin in development with `/api` proxied to the backend. In production the backend serves this build directly, so one command launches the whole stack. See [contributors/frontend.md](../docs/contributors/frontend.md) for the package layout, the mock auto-logon identity, the renderer contract, and how to run the dev server against a local backend. The stage plan is [Stage 4](../plans/stage-04-frontend-core.md).

```
npm run dev      # Vite dev server, /api proxied to the backend on :8080
npm run build    # production bundle into frontend/dist (served by the backend)
npm run check    # biome check + vue-tsc --noEmit
npm test         # Vitest (jsdom)
```

From the repo root, `npm start` builds this bundle and launches the backend serving it on `:8080` — a single command for the whole stack (a Docker daemon is still required to actually run sessions).
