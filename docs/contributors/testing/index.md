# Testing

While iterating, run the smallest check that covers your change. Before finishing, run every check the change requires.

## Test layers

```text
Fast feedback                         Highest confidence
lint + types → unit tests → integration → browser e2e → GitHub Actions
```

| Layer | Runs Docker? | Covers |
| --- | --- | --- |
| Python and TypeScript checks | No | Formatting, lint, types |
| Unit tests | No | Pure logic, routes with fakes, storage in memory, Vue in jsdom |
| Backend integration | Yes | Real images, containers, sandbox limits, submission overlays, load checks |
| Frontend e2e | Yes | Chromium against the real backend and session containers |
| Compose deployment smoke | Yes | The app image and compose topology booting against a real Linux daemon |
| Workflow rehearsal | Yes | GitHub Actions YAML through `act` |
| GitHub Actions | Varies | Suite of record and GitHub-only behavior |

## Everyday commands

```console
npm run check
npm run test
```

These commands run the normal lint, type, and unit-test loop across all workspaces.

For documentation:

```console
uv run python scripts/ci.py docs
```

For committed generated files after a schema, environment metadata, or environment packaging change:

```console
uv run python scripts/generate.py
uv run python scripts/ci.py generated-code-fresh
```

After changing a template layer, example, harness file, or shared template helper, run `uv run python scripts/ci.py examples` to compose and test every template.

## CI job runner

Verification jobs expose `scripts/ci.py` entry points for local use. The Docs workflow runs `mkdocs build --strict` directly, and template publishing has separate verification, publishing, and push steps. This table covers the `scripts/ci.py` jobs:

| Job | What it runs |
| --- | --- |
| `python` | Ruff, Pyright, pytest |
| `typescript` | Biome, TypeScript checks, Vitest |
| `generated-code-fresh` | Regenerate tracked outputs and fail on a diff |
| `examples` | Compose every example source tree in a fresh environment and run pytest |
| `docs` | `mkdocs build --strict` |
| `publish-dry-run` | Build the local frontend once, stage runnable student repositories, and do not push |
| `backend-integration` | Real Docker backend suite |
| `frontend-e2e` | Real backend, built frontend, Playwright Chromium (narrow it with `--group` or `--fast`) |
| `compose-smoke` | Build the app and proxy images and boot `compose.yaml` against a real Linux daemon |

The full local pull-request bar runs every non-Docker job plus the docs build and publish dry run, then the two Docker-heavy suites:

```console
uv run python scripts/ci.py all
uv run python scripts/ci.py backend-integration
uv run python scripts/ci.py frontend-e2e
```

The last two require a running Docker daemon. The manually dispatched `compose-smoke` job additionally needs a Linux daemon, so run it from the Actions tab or under WSL.

## Backend integration

```console
uv run python scripts/ci.py backend-integration
```

This suite builds the session image and verifies behavior that unit tests cannot:

- A scripted client completes a Flappy Bird session.
- A memory quota kills a container that exceeds it, and network restrictions isolate the container.
- Idle teardown and orphan reaping work.
- Submission overlays build and cache.
- Load checks report success and known failures.
- Overlay eviction protects active ready submissions.

CPU limits and a read-only root filesystem are part of the sandbox profile configuration, but no test in this suite asserts them behaviorally.

Git reachability and commit pinning against a real repository are covered by a separate, opt-in test (`backend/test/integration/submission-source-network.test.ts`). It runs only when `SUBMISSION_NETWORK_TESTS=1` is set, so it is skipped by default and is not part of this job.

Integration tests live under `backend/test/integration/`.

## Browser end-to-end

UI changes need matching jsdom tests and relevant browser journeys. Run the covering group while iterating and the full suite before handoff. [Browser end-to-end tests](browser-e2e.md) covers commands, groups, fixtures, and rules.

## Compose deployment smoke

```console
uv run python scripts/ci.py compose-smoke
```

This manually dispatched job boots a temporary Compose project on a Linux Docker daemon, checks that the proxy's published ports reached the host, and verifies the TLS boundary, proxy and Compose `app` container connectivity, mounted data, and session cleanup. It does not cover the Cloudflare source-IP allowlist, and it refuses to run while a repository-root `.env` or `.tls` exists. See [Run the app in Docker](../setup/docker.md) and [Execution boundary](../runtime/execution.md); on Windows, run it under WSL.

Backend integration covers the LLM network boundary.

## Examples and template checks

Each bare student template includes a working `act` method and should pass. A passing composed example confirms that the template and environment work together.

```console
uv run python scripts/ci.py examples
```

CI requires at least one example per environment and tests each one in a fresh virtual environment.

Run the publish dry run after changing release machinery. It verifies the publish-only browser bundle injection that ordinary composition intentionally omits:

```console
uv run python scripts/ci.py publish-dry-run
```

## Reproduce Linux CI

Run `scripts/ci.py` inside WSL to execute the same job contents on the same OS family as `ubuntu-latest`. Clone into the WSL filesystem rather than `/mnt/` for better small-file performance.

This reproduces each job's commands, but not workflow triggers or dependency ordering.

## Rehearse workflows with `act`

[`act`](https://github.com/nektos/act) runs GitHub Actions workflow YAML in Docker. The repository's `.actrc` selects an image with the required language toolchains.

Useful commands:

```console
act -l
act -j python
act pull_request
act push
```

Use `act -l` first to confirm that workflow YAML parses and lists the expected jobs.

`act` does not fully reproduce GitHub's event filters. Use `-W <workflow>` or `-j <job>` when you need precise scope.

## Rehearse template publishing

The publish workflow has verify and publish phases, followed by a push phase for a normal release. Republish mode skips the push phase. Only verify is safe under `act`:

```console
act workflow_dispatch -W .github/workflows/template-publish.yml -j verify --input version=0
```

Do not run publish or push locally with real credentials. They write to the student repository or this repository, and a normal push creates the release tag.

To test composition without network writes:

```console
uv run python scripts/publish_template.py --tag template-v0 --dry-run
```

## GitHub-only checks

Two operations require GitHub:

- Pages deployment: `.github/workflows/docs.yml` only runs `mkdocs build --strict`. The site is not deployed yet.
- Real template publication and release tagging with repository credentials.

Everything else should be exercised locally through the commands above before relying on CI.
