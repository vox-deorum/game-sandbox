# Stage 10: Documentation page

Status: complete

## Goal

The website's Documentation page renders the student guides in-app instead of a "coming soon" placeholder. A student reads getting-started, the agent interface, the environment guides, and submitting without leaving the site, and each deployment can replace the landing page with its own class home.

## Scope

Serve the `docs/students/` guides from the backend and render them in the Vue app, per the Documentation page row in [frontend.md](../docs/specs/frontend.md). Only the `students/` subtree is on the website; the specification and contributor guides stay in the repository and the MkDocs build, and links to them from a guide open their source on GitHub.

The backend reads the guides from disk at request time (no frontend rebuild to update a guide) through three unauthenticated read-only routes next to `GET /api/config`: `GET /api/docs/manifest` (the navigation tree), `GET /api/docs/index` (the landing page), and `GET /api/docs/pages/*` (one guide's markdown, path-sanitized to `students/`). The navigation order follows the students index's reading order, with unlisted pages appended alphabetically so a new guide appears without a code change.

The landing page is `docs/students/index.md` by default. A deployment can replace it by pointing `DOCS_INDEX_FILE` at a markdown file, so a class can put its schedule, links, or grading on the home page without editing the shared guides. The override keeps the students-index path for link resolution, so relative links in a copied index still work. A configured file that cannot be read fails the landing request loudly rather than falling back silently.

The frontend renders markdown with markdown-it. Because the guides are authored for MkDocs, the renderer reproduces two MkDocs behaviors: heading ids use the python-markdown slug (so a cross-page anchor such as `#chatinbox`, from the heading `` `chat(inbox)` ``, resolves), and relative `.md` links are rewritten relative to the current page. An in-scope link becomes an in-app route and navigates without a reload; an out-of-scope link becomes a GitHub source link; an external link opens in a new tab. Fenced code is highlighted for the languages the guides use (python, json, bash, shell/console, powershell) and rendered as escaped plain text otherwise.

## Implementation decisions

- `DOCS_DIR` (default the repo's `docs/`) and `DOCS_INDEX_FILE` join `Config` in `backend/src/config.ts`, mirroring the `FRONTEND_DIST` path-field precedent. `backend/src/docs.ts` builds the manifest and reads pages; `app.ts` registers the three routes and threads `docsDir`/`docsIndexFile` through `AppDeps`.
- Path sanitization rejects `..`, absolute paths, non-`.md`, and backslash tricks, and boundary-checks the resolved path against `students/` so an encoded traversal cannot escape.
- URL scheme mirrors the source paths: `/docs` for the landing, `/docs/students/...` for a guide, and a directory route for a section's `index.md`. `frontend/src/main.ts` adds a `/docs/:docPath(.*)` catch-all beside `/docs`.
- `frontend/src/docs/markdown.ts` owns the markdown-it instance, the slugify, and the link policy; `DocsMarkdown.vue` renders and intercepts in-app link clicks; `DocsPage.vue` fetches the manifest and page and renders the section navigation.

## Spec references

[frontend.md](../docs/specs/frontend.md) (Documentation page, navigation), [configuration.md](../docs/contributors/configuration.md) (`DOCS_DIR`, `DOCS_INDEX_FILE`).

## Depends on

Stage 4 (frontend core: the app shell, sidebar, routing, and design tokens) and Stage 3 (the backend and its config loader). Independent of the LLM gateway (Stage 9) and communication (Stage 8).

## Done when

The Documentation page renders the students index at `/docs` and every student guide under `/docs/students/...`, with a section navigation and working cross-page links and anchors. A link to a specification page opens on GitHub and an external link opens in a new tab. Setting `DOCS_INDEX_FILE` replaces only the landing page. Backend routes are covered by `backend/test/docs.test.ts`, the renderer and page by `frontend/test/docs-markdown.test.ts` and `frontend/test/docs-page.test.ts`, and the strict MkDocs build stays green.
