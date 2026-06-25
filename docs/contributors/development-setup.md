# Development Setup

## Prerequisites

- Python 3.12, managed with [uv](https://docs.astral.sh/uv/getting-started/installation/). The version is pinned in `.python-version`.
- Node 22, pinned in `.nvmrc` and enforced by `package.json`.
- Git.
- Docker Desktop when running sessions, integration tests, or browser end-to-end tests.

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

Use [Testing](test.md) to choose Docker-gated and release-workflow checks.

The defaults run the full stack locally with no environment variables set. See [Configuration](configuration.md) to tune the port, allowlists, sandbox quotas, and retention.

## Tooling at a glance

| Language | Format and lint | Types | Tests |
| --- | --- | --- | --- |
| Python | Ruff | Pyright | pytest |
| TypeScript and Vue | Biome | `tsc` and `vue-tsc` | Vitest and Playwright |

## Dev scripts

Every dev script is Python under `scripts/`, run through uv, so nothing depends on bash and the same command works on Windows and Linux.

| Intent | Command |
| --- | --- |
| Regenerate types, packaged schema, and fixtures | `uv run python scripts/generate.py` |
| Lint and typecheck both languages | `npm run check` |
| Run all Docker-free tests | `npm run test` |
| Compose a template or example | `uv run python scripts/compose.py <env> [name]` |
| Play-test an environment locally (no backend) | `npm run play -- <env> [human\|agent\|watch]` |
| Run one CI job exactly as CI does | `uv run python scripts/ci.py <job>` |
| Run the full local suite (all three workflows) | `uv run python scripts/ci.py all` |
| Publish the template and examples (dry-run available) | `uv run python scripts/publish_template.py --dry-run` |
| Run the app on the e2e-built database | `npm run demo` |
| Run the app as an ordinary member | `npm run demo:user` |
| Force a fresh e2e run before the demo | `npm run demo -- --rerun-e2e` |

`npm run demo` shows realistic sessions, submissions, seasons, and replays. It:

- Copies `frontend/e2e/.data/main/` into a fresh `demo/` directory.
- Runs `frontend-e2e` first if the source database does not exist.
- Serves the copied data on port 8080.
- Rebuilds the e2e database if a schema change makes the copy stale.

Demo play writes only to the disposable `demo/` copy, never to the `main/` fixture reused by local e2e runs.

By default the e2e run happens only when the source database is missing, so a successful run is reused indefinitely. Pass `--rerun-e2e` (`npm run demo -- --rerun-e2e`) to force a fresh run regardless of any prior result: it discards the existing e2e database and runs the suite again before launching, picking up changes to the specs or the data they produce. It composes with the member demo (`npm run demo:user -- --rerun-e2e`).

`npm run demo:user` is the same demo signed in as an ordinary member instead of the operator. It mocks `ada-lovelace` — the e2e fixture's most data-rich member (a submitted agent, an author rating prompt, watch recordings, and competition placements) — so the most member-facing features have real content. The member is allowlisted to play but is not an operator, so the admin console is locked exactly as it is for a real user.

`scripts/generate.py` owns TypeScript schema types, packaged schema copies, environment metadata, template environment copies, and golden fixtures. Edit the source, regenerate, and commit both. Do not hand-edit generated files.

`npm run build:image` runs from `backend/` and rebuilds the current session base image. Use it after changing the Dockerfile, harness, environment, or built-in agent. See [Backend](backend.md#run-and-test).

## Windows and WSL

The scripts are Python so Windows and Linux use the same commands. CI runs on Linux because session containers are Linux.

For close CI reproduction, clone into the WSL filesystem and run `scripts/ci.py` there. Avoid `/mnt/` for this repository because `node_modules` and template composition perform many small file operations.

[`act`](https://github.com/nektos/act) can run workflow YAML in Docker. It is useful for checking workflow wiring, but GitHub Actions remains the suite of record. See [Testing](test.md).
