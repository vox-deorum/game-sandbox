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
| Compose one example | `uv run python scripts/compose_example.py <name>` |
| Run one CI job exactly as CI does | `uv run python scripts/ci.py <job>` |
| Run the full local suite (all three workflows) | `uv run python scripts/ci.py all` |
| Publish the template and examples (dry-run available) | `uv run python scripts/publish_template.py --dry-run` |

Anything generated from the schema (the TypeScript types, the packaged schema copies, and the golden fixtures) is produced by `scripts/generate.py`. Do not edit those by hand; edit the schema and regenerate. CI fails if a generated artifact is stale.

## Windows and WSL

Development happens on Windows; CI is Linux-only on purpose, because session containers are Linux and the dev scripts stay cross-platform by being Python. There are two levels of local reproduction.

The first level reproduces a job's contents. Because every CI job is a single `scripts/ci.py <job>` call, running that same command inside a WSL distro with uv and Node installed executes exactly what `ubuntu-latest` executes, on the same OS family. Clone the repository into the WSL filesystem rather than working through `/mnt/`, which is slow for the many small file operations that composing examples and `node_modules` involve; a Windows checkout and a WSL checkout can coexist.

The second level reproduces the workflows themselves with [act](https://github.com/nektos/act), which runs the actual workflow YAML in Docker containers. Combined with the publish script's dry-run flag, the whole tag-to-publish path can be rehearsed locally without touching the student repository. `act` is a development convenience, not a gate; the suite of record stays GitHub Actions.

Both levels, the exact commands, and the parts only GitHub can test are laid out in [Testing end to end](test.md).
