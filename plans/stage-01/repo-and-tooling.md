# Stage 1: Repository Layout and Tooling

Part of [Stage 1](../stage-01-contracts.md). This file fixes the monorepo layout and the language tooling that every later stage inherits. The choices here are deliberately boring: one tool per job, nothing that needs its own maintenance.

## Layout at the end of Stage 1

```
schema/                  canonical JSON Schema files and the TypeScript package
  step-state.schema.json
  recording-header.schema.json
  fixtures/              committed golden recordings (written by Python, read by TypeScript)
  ts/                    npm workspace package @game-sandbox/schema
harness/                 uv workspace member, Python package game_sandbox_harness
environments/            placeholder README (filled in Stage 2)
backend/                 placeholder README (filled in Stage 3)
frontend/                placeholder README (filled in Stage 4)
templates/               placeholder template content (real content in Stage 2)
examples/                example overlays, starting with examples/hello/
gateway/                 placeholder README (filled in Stage 7)
docs/                    MkDocs source (see docs-site.md)
scripts/                 cross-platform Python dev scripts
build/                   gitignored output (composed examples, built docs)
.github/workflows/       ci.yml, docs.yml, template-publish.yml
mkdocs.yml
pyproject.toml           uv workspace root
package.json             npm workspace root
biome.json               Biome lint and format config
uv.lock, package-lock.json, .python-version, .nvmrc, .gitignore, .editorconfig
```

Placeholder directories hold a short README naming the stage that fills them, nothing else. Only `harness/` and `schema/ts/` are real packages in Stage 1.

## Python tooling

The root `pyproject.toml` declares a uv workspace whose members grow stage by stage, starting with `harness/`. Dev dependencies live in root dependency groups: `dev` carries ruff, pytest, and pyright; `docs` carries mkdocs-material. Python is pinned to 3.12 through `.python-version`, since 3.12 currently has the widest wheel coverage for the game and RL libraries Stage 2 pulls in.

Ruff does both linting and formatting, replacing black, isort, and flake8 with one fast tool. Pytest is the only Python test runner. Pyright type-checks the workspace, basic mode repo-wide and strict on `harness/`, because the contracts package is exactly where types pay for themselves.

## TypeScript tooling

npm workspaces from the root `package.json`, starting with `schema/ts`. Biome handles linting and formatting; it is one dependency with one config, it is fast, and this repo has no legacy eslint setup to honor. If a rule gap ever appears, switching costs little because nothing else depends on the config. Vitest is the test runner, which pairs naturally with the Vite frontend arriving in Stage 4. TypeScript runs in strict mode with `tsc --noEmit` as the typecheck step. Node is pinned to the 22 LTS line through `.nvmrc` and the `engines` field.

## Dev scripts

Every dev script is Python under `scripts/`, run as `uv run python scripts/<name>.py`. Development machines are Windows and CI is Linux, so nothing is written in bash. The root `package.json` and the docs map intents to commands:

| Intent | Command |
| --- | --- |
| Regenerate types, packaged schema, fixtures | `uv run python scripts/generate.py` |
| Lint and typecheck both languages | `npm run check` (fans out to ruff, pyright, biome, tsc) |
| Run all tests | `npm run test` (pytest plus vitest) |
| Compose one example | `uv run python scripts/compose_example.py <name>` |
| Run one CI job exactly as CI does | `uv run python scripts/ci.py <job>` |
| Publish template and examples (used by CI, runnable locally) | `uv run python scripts/publish_template.py` |

## Out of scope

Backend and frontend framework choices stay with Stages 3 and 4. Nothing here picks a server framework, a state library, or a bundler beyond what the schema package itself needs.
