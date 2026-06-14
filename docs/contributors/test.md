# Testing End to End

This page is the checklist for proving a change is sound before it leaves your machine. There are two levels. The first reproduces what every CI job _does_ and is the one you run constantly; the second reproduces the workflow YAML _itself_ and is the one you run before touching release machinery. Neither replaces GitHub Actions, which stays the suite of record, but together they catch everything reproducible off a Linux runner.

## One command: the full suite

Every GitHub Actions job is a single `scripts/ci.py <job>` call after dependency setup, so the workflow YAML carries triggers and caching but no logic. That means one command runs the local equivalent of all three workflows:

```
uv run python scripts/ci.py all
```

`all` runs, in order: the non-Docker `ci.yml` jobs (`python`, `typescript`, `generated-code-fresh`, `examples`), the strict docs build from `docs.yml`, and the `template-publish.yml` dry-run. It omits the two Docker-gated jobs, `backend-integration` and `frontend-e2e`, which launch real containers and so need a Docker daemon; run those on their own (see below). A green `all` plus green `backend-integration` and `frontend-e2e` is the bar for opening a pull request. Run the pieces individually while iterating:

| Job | Mirrors | What it does |
| --- | --- | --- |
| `python` | `ci.yml` | ruff check, ruff format --check, pyright, pytest |
| `typescript` | `ci.yml` | biome check, tsc --noEmit, vitest run — workspace-wide, so the backend rides this job too |
| `backend-integration` | `ci.yml` | the Docker-gated backend suite: build the session image, launch real containers (needs Docker) |
| `frontend-e2e` | `ci.yml` | the Docker-gated browser suite: Playwright drives Chromium against the real backend serving the built frontend (needs Docker) |
| `generated-code-fresh` | `ci.yml` | regenerate, then fail if anything generated changed |
| `examples` | `ci.yml` / publish `verify` | compose every example, install into a fresh venv, run its pytest |
| `docs` | `docs.yml` | `mkdocs build --strict` so broken links or refs fail |
| `publish-dry-run` | `template-publish.yml` | compose and assemble the publish snapshots without pushing |

The backend's Docker-gated suite is its own job because it needs a running daemon. With Docker Desktop up, run it directly:

```
uv run python scripts/ci.py backend-integration
```

It builds the session base image once (entirely inside Docker, from the repo sources) and then exercises the exit criteria that only mean something against a real container: a scripted WebSocket client playing Flappy Bird, the memory-quota and no-network sandbox guarantees, and the idle and orphan-reaping teardown paths. Stage 5 adds the submission gates here without a new job — the same `test/integration/**` project picks up `overlay-build.test.ts` (build a worked-example overlay, pass the load check, fail it with `class_not_found` / `import_error`, and exercise overlay caching plus oldest-first eviction with the active-`ready` exemption) and `submission-source-network.test.ts` (the live, non-interactive `git` reachability and pin path). An `act` run may skip it; it is a separate `ubuntu-latest` job in `ci.yml`, where the daemon is available.

The Docker-free side of Stage 5 needs no new wiring at all: the static validator (against the fixtures under `backend/test/fixtures/validate/`), the source resolution over a fake git runner, the API and validation worker, and the frontend form/profile/picker components all ride the workspace-wide `typescript` job, and the harness `validate` load-check outcomes ride the `python` job's pytest. The static-validator and `manifest.py` halves of the loader contract stay locked together through the same `generated-code-fresh` check that gates every cross-language artifact.

The browser end-to-end suite is the same shape — Docker-gated, its own job — for the frontend's experiential criteria. With Docker Desktop up:

```
uv run python scripts/ci.py frontend-e2e
```

It builds the frontend, builds the session base image, installs Playwright's Chromium, then runs the suite: Chromium drives the real backend serving the built bundle from one origin, so a scripted journey plays a live Flappy Bird session, pauses and resumes, stops, and opens the replay to scrub and pin it, with watch, spectator, and allowlist variations. The Stage 5 `submission.spec.ts` rides the same job: the `main` backend runs with the dev local-folder gate on, so a checked-in fixture drives the real resolve → static → build → load pipeline with no network. The submission is created through the API (the form's local-folder field is dev-only and absent from the production bundle this suite serves), and the browser then exercises the parts visible only there — a worked example reaches `ready`, its profile timeline shows every stage passed, and the watch picker runs it in a real scripted session; a deliberately broken example (a manifest naming a missing class) passes the static stage and fails the load stage, with the captured reason shown on the agent profile. Assertions stay on the DOM (controls, banners, the per-step window, the stage timeline) and that the canvas is painted, not on pixels, so the suite does not flake on font or GPU differences across runners. The suite lives in `frontend/e2e/` with `frontend/playwright.config.ts`, which starts two backend instances (one allowlisting the dev user and enabling local submissions, one allowlisting no one) so the allowlist variation has a non-allowlisted context.

```
uv run python scripts/ci.py python      # one job
uv run python scripts/ci.py docs        # just the strict docs build
```

Because the command is identical to what the runner executes, running it inside a WSL distro with uv and Node installed reproduces `ubuntu-latest` on the same OS family — see the Windows and WSL notes in [Development setup](development-setup.md). Clone into the WSL filesystem rather than working through `/mnt/`, which is slow for the many small file operations composing examples and `node_modules` involve.

## Level two: the workflows themselves with `act`

`scripts/ci.py all` proves the job _contents_ pass. It does not exercise the workflow YAML: the triggers, the `needs:` ordering, the pinned action versions, the matrix. [`act`](https://github.com/nektos/act) runs the actual workflow files in Docker containers, so it is the tool for verifying that wiring — and, with the publish dry-run, for rehearsing the whole tag-to-publish path locally without touching the student repository. `act` is a development convenience, not a gate.

### Prerequisites

- Docker Desktop running (on Windows, with the WSL 2 backend).
- `act` on your `PATH`. After installing it, open a fresh shell so the updated `PATH` takes effect.

The repository ships an [`.actrc`](https://github.com/vox-deorum/game-sandbox/blob/main/.actrc) that maps the `ubuntu-latest` runner to a catthehacker image bundling node, python, and the rest, so `setup-*` actions work. The first run pulls that image (~1 GB) once; subsequent runs reuse it and finish in a few minutes. Running the full suite this way is what confirms the generated artifacts are byte-identical on Linux, not just on a Windows checkout.

### Listing and running

```
act -l                       # list every job across all three workflows
act -j python                # run one CI job
act pull_request             # run everything triggered by a pull request
act push                     # run everything triggered by a push
```

`act pull_request` is the everyday whole-suite run: it executes the four `ci.yml` jobs and `docs.yml`'s `build`, while the Pages `deploy` job self-skips because its `if` requires a push to `main`. It is safe to run as-is — nothing touches the network beyond pulling dependencies.

One caveat to know before relying on the trigger commands: `act` does not evaluate the `on.push` path or tag filters that GitHub does. `act push` runs _every_ push-triggered job — both `ci.yml` jobs and `docs.yml`'s `build` fire even on a tag event — so scope to the workflow you mean to test with `-W <file>` or to a single job with `-j <id>`.

`act -l` is the quickest confirmation that the YAML parses and the jobs and triggers are wired as intended:

```
Stage  Job ID                Workflow name     Workflow file         Events
0      python                CI                ci.yml                pull_request,push
0      typescript            CI                ci.yml                pull_request,push
0      backend-integration   CI                ci.yml                pull_request,push
0      frontend-e2e          CI                ci.yml                pull_request,push
0      generated-code-fresh  CI                ci.yml                pull_request,push
0      examples              CI                ci.yml                pull_request,push
0      build                 Docs              docs.yml              pull_request,push
0      deploy                Docs              docs.yml              pull_request,push
0      verify                Publish Template  template-publish.yml  push
1      publish               Publish Template  template-publish.yml  push
```

### Rehearsing the publish pipeline

`template-publish.yml` is run manually (`workflow_dispatch`) with a `version` input N, not off a tag. It has three jobs: `verify` composes and tests every example (and rejects a version whose tag already exists), `publish` runs `scripts/publish_template.py` with no `--dry-run` — it actually pushes to the student repo — and `tag` stamps `template-v<N>` on this commit only after publish succeeds. That ordering is the recovery story: a failed run leaves no tag, so you fix the cause and re-run rather than deleting a dangling tag. The split also decides how you rehearse it.

The `verify` job is safe to run under `act`. Scope to the workflow file with `-W` and pass the dispatch input:

```
act workflow_dispatch -W .github/workflows/template-publish.yml -j verify --input version=0
```

Do not run the `publish` or `tag` jobs under `act`. With `TEMPLATE_REPO_TOKEN` unset `publish` raises before pushing; with a real token it pushes for real to `vox-deorum/game-agent-template`, and `tag` would push a release tag. There is no dry-run branch through the workflow, by design — a real publish should only ever come from the manual run on GitHub.

To rehearse what `publish` _composes and assembles_ without Docker or the network, run the script's own dry-run, which is exactly what `scripts/ci.py all` already includes:

```
uv run python scripts/publish_template.py --tag template-v0 --dry-run
```

## What can only be tested on GitHub

Two things have no local equivalent because they are GitHub-side by nature:

- **The Pages deploy** (`docs.yml`'s `deploy` job) uploads an artifact and calls `actions/deploy-pages`, which needs the `github-pages` environment and Pages enabled on the repository — neither reproducible under `act`. It is also temporarily disabled (commented out) until the site is public, so today only the strict build runs. Verify the build locally; trust GitHub for the publish once re-enabled.
- **The real template publish** (`template-publish.yml`'s `publish` and `tag` jobs) writes to `vox-deorum/game-agent-template` and then tags this repo. Rehearse it with the dry-run; do the real thing only by running the workflow manually from the Actions tab (or `gh workflow run template-publish.yml -f version=<N>`), with `TEMPLATE_REPO_TOKEN` set as a secret on the `template-publish` environment that the publish job declares. The workflow tags `template-v<N>` itself on success — you do not push the tag by hand.

Everything else — the cross-language round trip, the staleness check, the composed-example tests, the strict docs build, and the publish composition — is fully reproducible with the two levels above.
