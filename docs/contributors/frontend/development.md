# Frontend

The frontend is a Vue 3, Vite, and TypeScript browser app. It displays environments, submissions, sessions, replays, and leaderboards, and communicates with the backend through typed HTTP and WebSocket clients.

Use this page for the frontend development workflow. Read [the frontend specification](../../specs/frontend.md) for product behavior and [the interaction specification](../../specs/interaction.md) for the browser/server boundary. Before changing visuals, also read [the design system](design-system.md). Renderer-specific guidance lives in [Rendering](../environments/rendering.md).

## Source layout

Frontend code lives under `frontend/src/`.

| Path             | Responsibility                                  |
| ---------------- | ----------------------------------------------- |
| `pages/`         | Route-level components, named `*Page.vue`       |
| `components/`    | Feature components shared by pages              |
| `components/ui/` | Design-system primitives with the `Ui` prefix   |
| `composables/`   | Reusable stateful Vue behavior                  |
| `api/`           | Typed HTTP and WebSocket clients                |
| `lib/`           | Pure helpers                                    |
| `renderers/`     | Environment renderers and the renderer registry |
| `replay/`        | Recording parsing and replay transport          |
| `styles/`        | Design tokens and global styles                 |

`main.ts` creates the app and registers routes. `App.vue` installs the identity provider and application shell. Focused modules hold shared application state, such as the signed-in user and environment catalog. The project does not use a state-management library.

## Development workflow

The frontend requires Node.js 22. Run these commands from `frontend/`:

| Command         | Purpose                                                 |
| --------------- | ------------------------------------------------------- |
| `npm run dev`   | Start Vite and proxy `/api` to the backend on port 8080 |
| `npm run check` | Run Biome and TypeScript checks                         |
| `npm test`      | Run the Vitest unit tests                               |
| `npm run build` | Create the production build in `frontend/dist/`         |

For local development, run `npm run dev` separately in `backend/`. Docker is required only when the backend launches a session. From the repository root, `npm start` builds the frontend and starts the backend on port 8080.

When making a change:

1. Confirm the intended behavior in the relevant specification.
2. Keep route orchestration in a page, reusable UI in a component, and reusable stateful behavior in a composable.
3. Add backend calls to the typed API clients instead of calling `fetch` from components.
4. Update the jsdom and Playwright tests with any UI change, as [Testing](../testing/index.md#browser-end-to-end) requires.
5. Run `npm run check`, `npm test`, and `npm run build`.

After a UI change, also run the browser suite from the repository root. It requires a running Docker daemon:

```console
uv run python scripts/ci.py frontend-e2e
```

## Project conventions

### Navigation

`AppShell.vue` owns global navigation, while environment routes add their contextual tabs. Keep navigation state in the existing shell and sidebar composables, and use the product terms **Environment** and **Season** in visible copy.

### API and shared data

Keep HTTP wrappers in `api/client.ts` and session WebSocket behavior in `api/socket.ts`. Represent expected backend refusals, such as 403 or 409 responses, as typed results. Pages can then branch on stable error codes instead of message text.

Protocol and environment metadata types belong in `@game-sandbox/schema`. Do not create frontend-only copies. Reuse application-level loaders such as `environmentCatalog.ts`, `me.ts`, and `useSiteConfig.ts` instead of issuing the same request from multiple pages.

The browser receives identity from the same-origin Better Auth session cookie. Hiding an unavailable action improves the frontend experience, but the backend must still enforce authorization.

### Components and styles

Build features from the primitives in `components/ui/` and use semantic tokens from `styles/tokens.css`. Do not introduce raw color or spacing values in component styles. Renderer modules are exempt because each environment owns its game visuals.

For a confirmation dialog, use `UiDialogActions` instead of a feature-local action row. Put the consequential action first, use the `danger` button variant for irreversible work, and follow it with a ghost Cancel button.

Add every new primitive variant to the development-only `/styleguide` route. Follow the accessibility and visual rules in [the design system](design-system.md), and confirm new visual patterns with the project owner.

Global styles are limited to tokens, element defaults, application-shell layout, and deliberately shared presentation. Keep feature styles scoped to their components.

### Live sessions, replays, and renderers

Live sessions and replays share renderer and stage presentation, but their transports stay separate. Live pages own sockets and commands; replay pages own immutable recorded states and playback controls. Both use the renderer registry selected by environment metadata.

Do not add environment-specific behavior to shared pages. Implement it in the environment's renderer and follow the contract and checklist in [Rendering](../environments/rendering.md).

### In-app documentation

The Documentation page's product behavior, including which pages it serves, is specified in [the frontend specification](../../specs/frontend.md). Markdown compatibility and link rewriting live in `frontend/src/docs/markdown.ts`. Product documentation outside the student collection is linked to its source rather than served in the app.
