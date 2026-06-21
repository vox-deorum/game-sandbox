# Development Setup

## Prerequisites

- Python 3.12, managed with [uv](https://docs.astral.sh/uv/). The version is pinned in `.python-version`.
- Node 22 LTS, with the version pinned in `.nvmrc` and enforced by the `engines` field.

Install uv and Node, then from the repository root:

```
uv sync          # create the Python workspace virtualenv and install dev dependencies
npm install      # install the TypeScript workspace dependencies
```

## Tooling at a glance

The toolchain is deliberately one tool per job. On the Python side, ruff does both linting and formatting, pytest is the test runner, and pyright type-checks (basic repo-wide, strict on `harness/`, because the contracts package is where types pay for themselves). On the TypeScript side, Biome lints and formats, Vitest runs tests, and `tsc --noEmit` type-checks in strict mode.

## Dev scripts

Every dev script is Python under `scripts/`, run through uv, so nothing depends on bash and the same command works on Windows and Linux.

| Intent | Command |
| --- | --- |
| Regenerate types, packaged schema, and fixtures | `uv run python scripts/generate.py` |
| Lint and typecheck both languages | `npm run check` |
| Run all tests | `npm run test` |
| Compose a template or example | `uv run python scripts/compose.py <env> [name]` |
| Run one CI job exactly as CI does | `uv run python scripts/ci.py <job>` |
| Run the full local suite (all three workflows) | `uv run python scripts/ci.py all` |
| Publish the template and examples (dry-run available) | `uv run python scripts/publish_template.py --dry-run` |
| Run the app on the e2e-built database | `npm run demo` |

`npm run demo` (`scripts/demo.py`) is for showing the app off with realistic data rather than the empty seasons a bare `npm start` seeds. It reuses the rich database the `frontend-e2e` job leaves behind: sessions, submissions, released seasons, replays: instead of seeding anything: it snapshots that backend's data dir (`frontend/e2e/.data/main/`) into a fresh `demo/` copy on every launch and serves the app on `:8080`. If the e2e database does not exist yet it runs the `frontend-e2e` job first to build it (so the first run needs a Docker daemon, like the job itself). And because the flat migration is not re-run against a database that already recorded it (see [the backend](backend.md#running-it-locally)), a schema change since the e2e run leaves the copy stale; the backend then fails to start with a SQLite "no such column" error, so the demo rebuilds the e2e database from scratch and starts once more. Demo play writes only into the throwaway `demo/` copy, never the `main/` fixture that local e2e runs reuse.

Anything generated from the schema (the TypeScript types, the packaged schema copies, and the golden fixtures) is produced by `scripts/generate.py`. Do not edit those by hand; edit the schema and regenerate. CI fails if a generated artifact is stale.

One build helper lives outside `scripts/` because it drives the backend's own TypeScript build path rather than a Python wrapper around Docker: `npm run build:image` (re)builds the current dependency version's session base image from its registered version-specific Dockerfile. The backend builds it lazily on the first session and then reuses the tag, so run this after changing that Dockerfile or anything it bundles (the harness, an environment, the built-in agent); see [the backend](backend.md#running-it-locally).

## Windows and WSL

Development happens on Windows; CI is Linux-only on purpose, because session containers are Linux and the dev scripts stay cross-platform by being Python. There are two levels of local reproduction.

The first level reproduces a job's contents. Because every CI job is a single `scripts/ci.py <job>` call, running that same command inside a WSL distro with uv and Node installed executes exactly what `ubuntu-latest` executes, on the same OS family. Clone the repository into the WSL filesystem rather than working through `/mnt/`, which is slow for the many small file operations that composing examples and `node_modules` involve; a Windows checkout and a WSL checkout can coexist.

The second level reproduces the workflows themselves with [act](https://github.com/nektos/act), which runs the actual workflow YAML in Docker containers. Combined with the publish script's dry-run flag, the whole tag-to-publish path can be rehearsed locally without touching the student repository. `act` is a development convenience, not a gate; the suite of record stays GitHub Actions.

Both levels, the exact commands, and the parts only GitHub can test are laid out in [Testing end to end](test.md).
