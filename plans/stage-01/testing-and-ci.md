# Stage 1: Testing and CI

Part of [Stage 1](../stage-01-contracts.md). This file lays out the test strategy per package, the cross-language round trip that the stage's exit criteria hinge on, and the GitHub Actions workflows.

## Test strategy per package

`harness/` carries pytest suites for three things. Validator behavior: a valid state passes, each closed region rejects unknown fields, and the open `overlay` accepts anything. The folder store: a write-then-read round trip, a truncated file still yields a readable prefix, a version mismatch between header and lines is rejected, and a header declaring an unknown sidecar loads cleanly. The builders in `state.py` produce schema-valid output by construction.

`schema/ts` carries vitest suites for the guards and `readRecording`, consuming the committed golden fixtures under `schema/fixtures/`: a two-step recording that must parse into generated types with no casts, a fixture with a bumped `schema_version` that must be rejected, and a fixture whose header declares an unknown sidecar that must load cleanly. These three fixtures are the stage's exit criteria made executable.

`scripts/` carries pytest suites for compose precedence (overlay wins), the `requirements.extra.txt` merge, and the loud failure on a conflicting pin.

## The cross-language round trip

Python is the producer. The fixtures step of `scripts/generate.py` builds the golden recordings through the real `FolderRecordingStore`, validating on write, and commits them under `schema/fixtures/`. TypeScript is the consumer, reading them through generated types and Ajv guards in its test suite. The staleness job re-runs generation and diffs, so the committed fixtures provably come from current Python code, and the TypeScript tests provably parse current Python output. The loop closes without any CI-time file handoff between jobs, and any contract change shows up as a fixture diff in code review.

## Workflows

`ci.yml` runs on pull requests and pushes to main, on ubuntu-latest, with four jobs. `python`: uv sync, ruff check, ruff format --check, pyright, pytest. `typescript`: npm ci, biome check, tsc --noEmit, vitest run. `generated-code-fresh`: run the generate script, then `git diff --exit-code` over the three generated locations. `examples`: discover `examples/<env>/<name>`, compose each with `scripts/compose.py`, install into a fresh venv, run pytest (and fail if any environment layer ships no example); this becomes a matrix when there is more than one example.

Each job's steps are a single call to `scripts/ci.py <job>` after dependency setup, so the workflow YAML carries triggers and caching but no logic. Whatever CI runs, a developer can run with the same command, which is what makes local reproduction below trustworthy. `scripts/ci.py` carries two more jobs that mirror the other two workflows — `docs` (the strict `mkdocs build`) and `publish-dry-run` — and an `all` aggregate that runs every job in order, the full local equivalent of all three workflows and the one command to run before opening a pull request. The contributor-facing walkthrough is [../../docs/contributors/test.md](../../docs/contributors/test.md).

`docs.yml` is described in [docs-site.md](docs-site.md): strict builds on docs PRs, Pages deployment on main.

`template-publish.yml` is described in [examples-and-template-publishing.md](examples-and-template-publishing.md): a manually triggered (`workflow_dispatch`) verify, then publish, then tag, reusing the same compose and publish scripts CI runs; the `template-v<N>` tag is the workflow's last step rather than its trigger, so a failed run leaves nothing to clean up.

CI is Linux-only on purpose. Session containers are Linux, and the dev scripts stay cross-platform by being Python, so a Windows matrix adds cost without catching a class of bug we ship. Workflows use concurrency groups so superseded PR runs are cancelled.

## Running CI locally under WSL

Development happens on Windows, so CI must be reproducible on the dev machine through WSL. Two levels, from cheap to thorough.

The first level reproduces the job contents. Because every job is `scripts/ci.py <job>`, running that same command inside a WSL distro with uv and Node installed executes exactly what ubuntu-latest executes, on the same OS family. The contributor setup docs cover installing uv and Node inside WSL and recommend cloning the repository into the WSL filesystem rather than working through `/mnt/`, which is slow for the many small file operations that composing examples and node_modules involve; the Windows checkout and the WSL checkout can coexist.

The second level reproduces the workflows themselves with `act`, which runs the actual workflow YAML in Docker containers using Docker Desktop's WSL 2 backend. This is the tool for verifying triggers, job wiring, and the `template-publish.yml` pipeline before running the real publish: combined with the publish script's dry-run flag (see [examples-and-template-publishing.md](examples-and-template-publishing.md)), the whole publish path can be rehearsed locally without touching the student repository. All six jobs across the three workflows have been run green under `act`, which also confirmed that the staleness check passes when generation runs on Linux, not only on a Windows checkout. One quirk worth knowing: `act` does not honor `on.push` path or tag filters, so `act push` fans out to every push-triggered job — scope with `-W <file>` or `-j <id>`. `act` is a development convenience, not a gate; the suite of record stays GitHub Actions.
