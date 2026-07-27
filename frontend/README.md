# frontend/

The Vue 3, Vite, and TypeScript browser app. Development proxies `/api` to the backend. Production is built into `frontend/dist/` and served by the backend.

Run these commands from `frontend/`:

```console
npm run dev
npm run build
npm run check
npm test
```

From the repository root, `npm start` builds the frontend and starts the backend on port 8080. It needs a running Docker daemon because the backend reaps managed containers during startup. Docker is also required for sessions and Docker-gated tests.

See [Frontend](../docs/contributors/frontend/development.md), [Rendering](../docs/contributors/environments/rendering.md), and the [design system](../docs/contributors/frontend/design-system.md).
