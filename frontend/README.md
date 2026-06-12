# frontend/

The Game Sandbox web app: React with Vite and TypeScript, served on one origin in development with `/api` proxied to the backend. See [contributors/frontend.md](../docs/contributors/frontend.md) for the package layout, the mock auto-logon identity, the renderer contract, and how to run the dev server against a local backend. The stage plan is [Stage 4](../plans/stage-04-frontend-core.md).

```
npm run dev      # Vite dev server, /api proxied to the backend on :8080
npm run check    # biome check + tsc --noEmit
npm test         # Vitest (jsdom)
```
