# Examples and the Template

The student kit is composed from layers:

```text
templates/base
      +
templates/<env>
      +
examples/<env>/<name>   (optional)
      ↓
complete runnable repository
```

`templates/base/` contains the shared manifest, dependencies, and tests, plus the provided tooling under `sandbox/` (the `sandbox.play`/`sandbox.evaluate` scripts and the `python -m sandbox` helper). `templates/<env>/` adds the environment's starting agent (`agent.py`) and the generated local game package under `sandbox/env/`. A student edits only `agent.py` at the repository root; everything under `sandbox/` is provided. An example stores only its differences from the composed template.

This keeps shared files in one place and examples small enough to review.

Three environment layers ship today.

- `flappy_bird` is the single-slot game whose base `sandbox/play.py` fits unchanged.

- `hearts` is the four-slot turn-based card game; because its local loop is turn-based and seats a human among agents, its layer overrides `sandbox/play.py` whole-file (the one case step 3 below allows). It carries four single-idea example agents (`examples/hearts/{duck,moonshot,assassin,closer}/`).

- `spades` is the four-slot partnership card game; like Hearts it overrides `sandbox/play.py` whole-file for its turn-based bid-then-play loop, and its `sandbox/cards.py` helper reads the object-shaped observation and bridges the combined `Discrete(66)` bid-and-card action space so an agent works with card objects and bid numbers rather than raw arrays and the mask.

## Composing

`scripts/compose.py` composes in one or two steps:

- `scripts/compose.py <env>` copies `templates/base/**` into `build/templates/<env>/`, then overlays `templates/<env>/**` on top with whole-file replacement, so an env-layer file always wins.
- `scripts/compose.py <env> <name>` composes that template, then overlays `examples/<env>/<name>/**` on top, again whole-file.
- `scripts/compose.py` with no arguments lists the known environments and examples.

Composition uses whole-file replacement. The only special merge is `requirements.extra.txt`, whose lines append to `requirements.txt`. An extra may not override an existing pin.

Compose also ships each environment's student page inside the template as `environment.md`, so the game's observation/action reference lives in one source, the docs page, instead of being duplicated into the template's `README.md`. `compose.py` copies `docs/students/environments/<env>.md` (the env id with underscores turned into hyphens) into the composed template, rewriting its cross-doc Markdown links (for example `../agent-interface.md`) into `{{DOCS_URL}}` links so they still resolve from a student's clone; in-page anchors and external links are left untouched. Compose fails loudly if an environment has no docs page. The template's `README.md`, `agent.py`, and helper module point at the local `environment.md` rather than a docs-site link.

Compose then resolves that documentation link token. It replaces every `{{DOCS_URL}}` with the `site_url` from `mkdocs.yml` (with a trailing slash) in the composed Markdown and Python, then fails if the token survives anywhere in the output. Because the hand-written template sources no longer link to the docs site, `environment.md`'s rewritten links are the token's only source in a composed template; the substitution still runs (and its survivor sweep still guards) so every composed artifact CI tests or the publish workflow ships carries the real address. A docs page at `docs/students/environments/<env>.md` is reached as `{{DOCS_URL}}students/environments/<env>/`, since MkDocs serves pages as directories.

The dependency set is global and versioned as `template-v<N>`. Environment layers cannot include requirements files. File deletion during composition is not supported until a real need justifies a deletion manifest.

There is no separate composition manifest. Directory conventions, whole-file overlays, and the one dependency-extension rule are the complete mechanism, which keeps a composed repository easy to inspect.

## Why template updates propagate automatically

CI composes every example from the current `templates/` on every pull request and runs the composed example's tests in a fresh virtualenv. The base layer carries a pytest `tests/` directory and a `requirements-dev.txt`, so every composed example inherits them. A base or env-layer change that breaks an example fails the pull request that made the change, not some later discovery. This is the entire reason for the overlay design.

The bare template composes into a passing repo, because it ships a working starting agent. A composed example additionally proves that a worked strategy builds on the env layer. Every environment must ship at least one example, which CI composes and tests on every pull request.

## Adding an environment template

1. Add the environment to the environments package (see [Adding an environment](environments.md)).
2. Register it in `scripts/_paths.py` `TEMPLATE_ENVS` (env id → the import-self-contained modules to sync) and add its generated `__init__` texts in `scripts/generate.py`. The top-level `sandbox/env/__init__.py` must expose the uniform surface the provided scripts read: `make_env`, `ENV_ID`, `PLAYER_SLOT`, and `make_human_controller`. To make the environment human-playable, include its `human.py` (the `make_human_controller` factory) in the `TEMPLATE_ENVS` entry so it syncs alongside the env modules.
3. Create the `templates/<env>/` layer: at minimum a working starting `agent.py` (the naive agent the docs page builds) and a `README.md`, plus, when the observation or action needs decoding, a plain-Python helper module at `sandbox/<name>.py` and its pin test at `tests/test_<name>.py`. The base `sandbox/play.py` is environment-agnostic; override it whole-file in the env layer only if the local loop does not fit.
4. Run `scripts/generate.py` to sync `templates/<env>/sandbox/env/`.
5. Add at least one example under `examples/<env>/<name>/`, reading the observation through the helper module so it models the intended style.
6. Write the student documentation page `docs/students/environments/<env>.md` and add its row to the environments index. Compose ships this page inside the template as `environment.md`, so it is the single source for the game's reference; the template's `README.md` and `agent.py` point at it rather than restating it. The [student-facing deliverables](environments.md#student-facing-deliverables) section lists the required page sections, the helper placement rules, and the template docstring and README standards.

## Tags and publishing

Students use the separate `vox-deorum/game-agent-template` repository. Monorepo tags named `template-v<N>` identify dependency-set versions used by agent manifests.

`N` is one number wearing several hats (see `backend/src/deps-version.ts`): the `template-v<N>` release tag, the `deps-v<N>` session-image tag, and the `template_version` an agent manifest targets. A release keeps them in lockstep automatically — `scripts/bump_template_version.py` performs the bump and the `template-publish` workflow runs it, so the operator no longer hand-edits any version constant. On every pull request, CI's generated-code-fresh job runs `bump_template_version.py --check`, which fails if those touchpoints ever disagree.

### Cutting a release

Dispatch the **Publish Template** workflow from `main` (Actions tab or `gh workflow run`) with the version input `N`:

- `N` greater than the current version **bumps** the repo to exactly `N`: `templates/base/manifest.json`, the `frontend/e2e/fixtures/submission/*` manifests, `DEPS_VERSION` and its `SESSION_BASE_IMAGES` registry entry, and a new frozen `backend/images/session-base/deps-v<N>/` snapshot (its `requirements.txt` frozen from the current `templates/base/requirements.txt`, the previous Dockerfile with its paths and version prose rewritten, and the built-in agents with bumped manifests).
- `N` equal to the current version **republishes the tree as-is** (the retry path after a partial failure, or a repo already bumped by hand).
- `N` less than the current version is **refused** — publishing an older label would mislabel the release.

**Escape hatch:** when the image _recipe_ itself must change (a new system library, a different base image), hand-craft `backend/images/session-base/deps-v<N>/` in an ordinary PR first. The bump script detects an existing `deps-v<N>/`, leaves it untouched, and only validates it — so the deliberate snapshot wins over the mechanical copy.

### What the workflow does, in order

The workflow is a thin wrapper around `bump_template_version.py`, `scripts/compose.py`, and `scripts/publish_template.py` — the same code paths developers and CI use, so a student's clone is byte-identical to what CI tested. It runs three jobs so that a failure anywhere leaves `main` and the tags untouched:

1. **verify** bumps the repo, commits that bump locally, and runs the full CI suite (`scripts/ci.py all`) on the exact release commit. That commit gets no other CI — a later bot push to `main` does not trigger `ci.yml` — so this job is its only gate. The commit is bundled as a workflow artifact for the next jobs.
2. **publish** checks out the bundled release commit and updates the student repository from it (so its `Template v<N> from game-sandbox@<sha>` message names the commit that will be tagged):
   - The **default environment's** composed template becomes the repository's `main` branch content, with a mirrored tag `v<N>`, so "Use this template" instantiates a runnable kit for the default game.
   - Each environment's composed template is force-pushed to an orphan branch `templates/<env>` (a fresh snapshot per release with no shared history).
   - Each example is composed and force-pushed to an orphan branch `examples/<env>/<name>`.
3. **push** — only after the student repo is fully updated — fast-forwards `main` to the release commit and, last of all, tags it `template-v<N>`.

Students pick an environment or example from the branch dropdown to browse or clone a complete, runnable agent repo.

**Recovery:** if `main` advances during a run, the fast-forward push fails and no tag is written, so the fix is to dispatch a fresh run (the student-repo publish force-pushes, so a partial attempt is overwritten cleanly). The `dry_run: true` input rehearses the entire path — bump, commit, full CI, and a dry-run compose — while pushing nothing to the student repo, `main`, or tags. The publish script's own `--dry-run` flag does the same for a local run.

Note the new `deps-v<N>` image is not _built_ by this workflow (it has no Docker); its first real build happens at the next Docker-gated run, so dispatch **e2e.yml** after a release to build the image and exercise the bumped fixtures against seeded seasons.

Versioning has two relevant axes:

- `schema_version` for breaking state-contract changes.
- `template-v<N>` for the global student dependency set.

The monorepo has no repository-wide semantic version.
