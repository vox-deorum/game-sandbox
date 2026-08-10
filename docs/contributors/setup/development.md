# Development Setup

## Prerequisites

- Python 3.12, managed with [uv](https://docs.astral.sh/uv/getting-started/installation/) and pinned in `.python-version`.
- Node 22, pinned in `.nvmrc`; the root `package.json` declares the supported range.
- Git.
- A running Docker daemon for full-stack startup, sessions, integration tests, and browser end-to-end tests. Docker Desktop provides one on Windows.

To run the app itself inside a container on a Linux daemon, see [Run the app in Docker](docker.md); the rest of this page covers the host-process flow.

## Guided setup

From the repository root, run `./setup.sh` on Linux, WSL2, or macOS. On Windows, run `powershell -ExecutionPolicy Bypass -File .\setup.ps1`. The setup script installs uv when needed and guides you through local development, host deployment, or Docker deployment.

For a manual host-process setup, run these commands from the repository root:

```console
uv sync
npm install
```

`uv sync` creates the Python workspace environment. `npm install` installs all npm workspaces.

## First verification

```console
npm run check
npm run test
uv run python scripts/ci.py docs
```

Use [Testing](../testing/index.md) to choose Docker-gated and release-workflow checks.

The committed defaults let the stack run with no setup. See [Configuration](configuration.md#how-configuration-loads) for precedence and where private credentials go.

## Tooling at a glance

| Language | Format and lint | Types | Tests |
| --- | --- | --- | --- |
| Python | Ruff | Pyright | pytest |
| TypeScript and Vue | Biome | `tsc` and `vue-tsc` | Vitest and Playwright |

## Dev scripts

The backend, sessions, and Docker-gated checks need a running Docker daemon; see [Run and test](../runtime/backend.md#run-and-test) for why. The lint, typecheck, unit-test, composition, and local-play commands do not.

| Intent | Command |
| --- | --- |
| Set up and run a checkout interactively | `./setup.sh` or `powershell -ExecutionPolicy Bypass -File .\setup.ps1` |
| Regenerate JSON Schema, packaged schema, and fixtures | `uv run python scripts/generate.py` |
| Lint and typecheck both languages | `npm run check` |
| Run all Docker-free tests | `npm run test` |
| Compose a template or example source tree | `uv run python scripts/compose.py <env> [name]` |
| Play-test an environment locally (browser loopback, no backend) | `npm run play -- <env> [human\|agent\|watch]` |
| Run one CI job exactly as CI does | `uv run python scripts/ci.py <job>` |
| Run the full local suite (every non-Docker workflow job) | `uv run python scripts/ci.py all` |
| Run the publish dry run for the template and examples | `uv run python scripts/ci.py publish-dry-run` |
| Run the app from the browser e2e fixture | `npm run demo` |
| Rebuild the demo fixture, then run the app | `npm run demo -- --rerun-e2e` |

`npm run demo` serves a disposable browser e2e fixture on port 8080 and prints bootstrap administrator and student credentials. See [Data folders](../data/folders.md) for its lifecycle.

`scripts/generate.py` produces canonical JSON Schema files (built from the hand-written Zod schemas), packaged schema copies, environment metadata, packaging declarations, and golden fixtures. Edit the source, regenerate, and commit both the source and generated files. Do not edit generated files by hand.

`scripts/compose.py` composes a template or example into build output; see [Composition](../environments/templates.md#composition) for what it generates.

`npm run build:image` runs from `backend/` and rebuilds the current session base image. Use it after changing the Dockerfile, harness, environment, or built-in agent. See [Backend](../runtime/backend.md#run-and-test).

## Keeping local outputs fresh

Rerun the demo after e2e or fixture changes, or when its fixture is incomplete. After a flat schema or harness-launch change, recreate the database, recompose templates and examples, and rebuild the session image because these outputs are tied to the current checkout. See [Data folders](../data/folders.md) and [Template product and releases](../environments/templates.md).

The local browser export is release-only output. A release or publish dry run builds `frontend/dist-local/` and adds it to staged templates and examples, so publication requires Node while ordinary generation and source composition do not.

## Windows and WSL

The scripts are Python so Windows and Linux use the same commands. CI runs on Linux because session containers are Linux. To reproduce it closely, run the jobs inside WSL as described in [Reproduce Linux CI](../testing/index.md#reproduce-linux-ci).

[`act`](https://github.com/nektos/act) can run workflow YAML in Docker. It is useful for checking workflow wiring, but GitHub Actions remains the suite of record. See [Testing](../testing/index.md).
