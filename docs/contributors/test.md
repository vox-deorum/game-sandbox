# Testing

Use the smallest relevant check while iterating, then run the complete set required by the change.

## Test layers

```text
Fast feedback                         Highest confidence
lint + types → unit tests → integration → browser e2e → GitHub Actions
```

| Layer | Runs Docker? | Covers |
| --- | --- | --- |
| Python and TypeScript checks | No | Formatting, lint, types |
| Unit tests | No | Pure logic, routes with fakes, storage in memory, Vue in jsdom |
| Backend integration | Yes | Real images, containers, limits, Git source, load checks |
| Frontend e2e | Yes | Chromium against the real backend and session containers |
| Workflow rehearsal | Yes | GitHub Actions YAML through `act` |
| GitHub Actions | Varies | Suite of record and GitHub-only behavior |

## Everyday commands

```console
npm run check
npm run test
```

These run the normal lint, type, and unit-test loop across the workspaces.

For documentation:

```console
uv run python scripts/ci.py docs
```

For generated artifacts after changing schemas, environment metadata, or synced template code:

```console
uv run python scripts/generate.py
uv run python scripts/ci.py generated-code-fresh
```

## CI job runner

Every workflow job delegates to `scripts/ci.py`, so the same entry point works locally:

| Job | What it runs |
| --- | --- |
| `python` | Ruff, Pyright, pytest |
| `typescript` | Biome, TypeScript checks, Vitest |
| `generated-code-fresh` | Regenerate tracked outputs and fail on a diff |
| `examples` | Compose every example source tree in a fresh environment and run pytest |
| `docs` | `mkdocs build --strict` |
| `publish-dry-run` | Build the local frontend once, stage runnable student-repository snapshots, and do not push |
| `backend-integration` | Real Docker backend suite |
| `frontend-e2e` | Real backend, built frontend, Playwright Chromium |

Run every non-Docker job plus the docs build and publish dry run:

```console
uv run python scripts/ci.py all
```

The full local pull-request bar is:

```console
uv run python scripts/ci.py all
uv run python scripts/ci.py backend-integration
uv run python scripts/ci.py frontend-e2e
```

The last two require a running Docker daemon.

## Backend integration

```console
uv run python scripts/ci.py backend-integration
```

This suite builds the session image and verifies behavior that unit tests cannot:

- A scripted client completes a Flappy Bird session.
- CPU, memory, read-only filesystem, and network restrictions apply.
- Idle teardown and orphan reaping work.
- Submission overlays build and cache.
- Load checks report success and known failures.
- Overlay eviction protects active ready submissions.
- Git reachability and commit pinning work non-interactively.

Integration tests live under `backend/test/integration/`.

## Browser end-to-end

```console
uv run python scripts/ci.py frontend-e2e
```

This job is **not** part of the per-push CI. It is too Docker-heavy and slow to run on every push, so it lives in its own manually-dispatched workflow (`.github/workflows/e2e.yml`) — trigger it from the Actions tab (**Run workflow**), or run it locally with the command above.

The Playwright journey builds the frontend and session image, starts the real backend, and drives Chromium through:

- Live play, pause, resume, and stop.
- Replay opening, scrubbing, and pinning.
- Watch, spectator, and authorization/status cases.
- Submission stages from resolve through load.
- A ready example launched from the watch picker.
- A load failure caused by a missing class.
- Season, leaderboard, and rating behavior covered by the current journeys.

Assertions target the DOM and confirm that the canvas is painted. They do not compare pixels.

Every local run starts from a fresh database, the suite doubles as the demo's data fixture, and the leaderboards arc drives a whole season end to end. See [End-to-end tests](e2e-tests.md) for the data setup, the naming conventions, and how to add a spec or fixture.

Any UI change that renames text, changes markup, moves a control, or alters a flow must update both the jsdom tests under `frontend/test/` and relevant Playwright journeys under `frontend/e2e/`.

## Examples and template checks

The bare student template fails by design until `act` is implemented. A composed example is the green proof that the template and environment work together.

```console
uv run python scripts/ci.py examples
```

CI requires at least one example per environment and tests each example in a fresh virtual environment.

Use the publish dry run before changing release machinery. It verifies the publish-only browser bundle injection that ordinary composition intentionally omits:

```console
uv run python scripts/ci.py publish-dry-run
```

## Reproduce Linux CI

Run `scripts/ci.py` inside WSL to execute the same job contents on the same OS family as `ubuntu-latest`. Clone into the WSL filesystem rather than `/mnt/` for better small-file performance.

This reproduces job commands, not workflow triggers or dependency ordering.

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

The publish workflow has verify, publish, and tag phases. Only verify is safe under `act`:

```console
act workflow_dispatch -W .github/workflows/template-publish.yml -j verify --input version=0
```

Do not run publish or tag locally with real credentials. They write to the student repository and create a release tag.

To test composition without network writes:

```console
uv run python scripts/publish_template.py --tag template-v0 --dry-run
```

## GitHub-only checks

Two operations require GitHub:

- Pages deployment through the `github-pages` environment.
- Real template publication and release tagging with repository credentials.

Everything else should be exercised locally through the commands above before relying on CI.
