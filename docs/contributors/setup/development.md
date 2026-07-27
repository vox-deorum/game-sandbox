# Development Setup

## Prerequisites

- Python 3.12, managed with [uv](https://docs.astral.sh/uv/getting-started/installation/). The version is pinned in `.python-version`.
- Node 22, pinned in `.nvmrc`; the root `package.json` declares the supported range.
- Git.
- A running Docker daemon for full-stack startup, sessions, integration tests, and browser end-to-end tests. Docker Desktop provides one on Windows.

From the repository root:

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

The committed `.env.default` file provides the runtime defaults and enables loopback-only development authentication. You can therefore run the full stack locally without setting environment variables first. Put machine-specific overrides and private credentials in `.env` at the repository root; Git ignores this file. See [Configuration](configuration.md#how-configuration-loads) for precedence and the full variable reference.

## Tooling at a glance

| Language | Format and lint | Types | Tests |
| --- | --- | --- | --- |
| Python | Ruff | Pyright | pytest |
| TypeScript and Vue | Biome | `tsc` and `vue-tsc` | Vitest and Playwright |

## Dev scripts

Starting the backend, including `npm start` and `npm run demo`, needs a running Docker daemon because startup reaps managed containers. Docker is also required for sessions and Docker-gated checks. The lint, typecheck, unit-test, composition, and local-play commands do not need it.

| Intent | Command |
| --- | --- |
| Regenerate types, packaged schema, and fixtures | `uv run python scripts/generate.py` |
| Lint and typecheck both languages | `npm run check` |
| Run all Docker-free tests | `npm run test` |
| Compose a template or example source tree | `uv run python scripts/compose.py <env> [name]` |
| Play-test an environment locally (browser loopback, no backend) | `npm run play -- <env> [human\|agent\|watch]` |
| Run one CI job exactly as CI does | `uv run python scripts/ci.py <job>` |
| Run the full local suite (every non-Docker workflow job) | `uv run python scripts/ci.py all` |
| Publish the template and examples (dry-run available) | `uv run python scripts/publish_template.py --dry-run` |
| Run the app on the e2e-built database | `npm run demo` |
| Force a fresh e2e run before the demo | `npm run demo -- --rerun-e2e` |

`npm run demo` serves a disposable copy of the browser e2e fixture on port 8080, with realistic sessions, submissions, seasons, and replays. It never writes to the `main` fixture reused by local e2e runs. The command prints the bootstrap administrator and ordinary student credentials so you can explore both roles. If a partial e2e run left the student account out of the fixture, rebuild it with `npm run demo -- --rerun-e2e`.

The demo creates the source fixture when it is missing. Run `npm run demo -- --rerun-e2e` after changing e2e specs or fixture data to discard the existing source fixture, rebuild it, and then start the demo.

`scripts/generate.py` produces TypeScript schema types, packaged schema copies, environment metadata, packaging declarations, and golden fixtures. Edit the source, regenerate, and commit both the source and generated files. Do not edit generated files by hand.

`scripts/compose.py` generates the student-facing environment package, copied `sandbox.harness` package, and shared helpers directly in build output. These files are not tracked under `templates/`.

The database schema, composed templates, and session images are development artifacts tied to the current checkout. After a flat schema or environment launch-contract change, recreate the local database, recompose templates and examples, and rebuild the current session image. There is no compatibility path for artifacts produced by an older checkout.

The local browser export stays outside the template source tree. A release or publish dry run builds `frontend/dist-local/` once, then adds that output to `sandbox/web/` in each staged template and example. Publication therefore requires Node, but ordinary generation and source composition do not require a frontend bundle.

`npm run build:image` runs from `backend/` and rebuilds the current session base image. Use it after changing the Dockerfile, harness, environment, or built-in agent. See [Backend](../runtime/backend.md#run-and-test).

## Windows and WSL

The scripts are Python so Windows and Linux use the same commands. CI runs on Linux because session containers are Linux. To reproduce it closely, run the jobs inside WSL as described in [Reproduce Linux CI](../testing/index.md#reproduce-linux-ci).

[`act`](https://github.com/nektos/act) can run workflow YAML in Docker. It is useful for checking workflow wiring, but GitHub Actions remains the suite of record. See [Testing](../testing/index.md).
