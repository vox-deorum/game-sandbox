# frontend/

The Vue 3, Vite, and TypeScript browser app. Development proxies `/api` to the backend. Production is built into `frontend/dist/` and served by the backend.

```console
npm run dev
npm run build
npm run check
npm test
```

From the repository root, `npm start` builds the frontend and starts the backend on port 8080. Docker is required only when a session launches.

See [Frontend](../docs/contributors/frontend.md), [Rendering](../docs/contributors/rendering.md), and the [design system](../docs/contributors/design.md).
