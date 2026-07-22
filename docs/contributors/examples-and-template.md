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

`templates/base/` holds the shared manifest, dependencies, and tests, plus the provided tooling under `sandbox/` (the `sandbox.play`/`sandbox.evaluate` scripts, the `python -m sandbox` helper, and dependency-free helpers shared across environment layers). `templates/<env>/` adds the environment's starting `agent.py` and the generated local game package under `sandbox/env/`. A student edits only `agent.py` at the repository root. Everything under `sandbox/` is provided. An example stores only its differences from the composed template.

This keeps shared files in one place and keeps examples small enough to review.

Three environment layers ship today.

- `flappy_bird` is the single-slot game. The base `sandbox/play.py` fits it unchanged.
- `hearts` is the four-slot turn-based card game. It uses the shared browser-local `sandbox/play.py` command, carries four single-idea heuristic agents (`examples/hearts/{duck,moonshot,assassin,closer}/`), and includes the LLM-backed oracle example (`examples/hearts/oracle/`).
- `spades` is the four-slot partnership card game. It also uses the shared browser-local command. Its `sandbox/cards.py` helper reads the object-shaped observation and bridges the combined `Discrete(66)` bid-and-card action space, so an agent works with card objects and bid numbers rather than raw arrays and the mask.

The copied `sandbox.harness` package owns manifest-based agent loading, the live episode loop, recording, and the local relay. The shared `sandbox/play.py` command builds the local configuration and starts the browser page, so every template uses the same input, pacing, and rendering path.

The base `sandbox.semantic_cards` module likewise holds only game-independent semantic-card constants and functions. Hearts and Spades import those operations into their separate `sandbox.cards` modules and re-export the same public names they exposed before. Their rules, legality, scoring, bidding, partnership, and observation accessors remain environment-specific.

## Composing

`scripts/compose.py` composes in one or two steps:

- `scripts/compose.py <env>` copies `templates/base/**` into `build/templates/<env>/`, then overlays `templates/<env>/**` on top with whole-file replacement, so an env-layer file always wins.
- `scripts/compose.py <env> <name>` composes that template, then overlays `examples/<env>/<name>/**` on top, again whole-file.
- `scripts/compose.py` with no arguments lists the known environments and examples.

Composition uses whole-file replacement. The only special merge is `requirements.extra.txt`, whose lines append to `requirements.txt`. An extra may not override an existing pin.

Composition works only from tracked source files. The exported local browser bundle is neither generated into `templates/base/sandbox/web/` nor committed. When `scripts/publish_template.py` publishes or performs a dry run, it builds `frontend/dist-local/` once and copies that export into `sandbox/web/` for every staged template and example. The published student repositories therefore contain the runnable browser page, while ordinary generation and composition do not require a frontend build.

Compose also ships student documentation inside each template. It copies the environment page from `docs/students/environments/<env>.md` (the env id with underscores turned into hyphens) to `environment.md`, and copies the shared LLM guide from `docs/students/llm.md` to `llm.md`. The environment's observation and action reference and the shared model-access rules therefore each have one source instead of being duplicated into template READMEs. Composition rewrites cross-doc Markdown links to `{{DOCS_URL}}` tokens, leaves in-page anchors and external links untouched, and fails loudly when a required source page is missing.

Compose then resolves that token. It replaces every `{{DOCS_URL}}` with the `site_url` from `mkdocs.yml` (with a trailing slash) in the composed Markdown and Python, then fails if any token survives. A docs page is reached as `{{DOCS_URL}}students/environments/<env>/`, since MkDocs serves pages as directories. The template's own `README.md`, `agent.py`, and helper module point at the local `environment.md`, so the rewritten page links are the token's only source in a composed template. See [student-facing deliverables](environments.md#student-facing-deliverables) for the env-author side of this rule.

The dependency set is global and versioned as `template-v<N>`. Environment layers cannot include requirements files. File deletion during composition is not supported until a real need justifies a deletion manifest.

There is no separate composition manifest. Directory conventions, whole-file overlays, and the one dependency-extension rule are the complete mechanism, which keeps a composed repository easy to inspect.

## Why template updates propagate automatically

CI composes every example from the current `templates/` on every pull request and runs the composed example's tests in a fresh virtualenv. The base layer carries a pytest `tests/` directory and a `requirements-dev.txt`, so every composed example inherits them. A base or env-layer change that breaks an example fails the pull request that made the change, not some later discovery. This is the entire reason for the overlay design.

The bare template composes into a passing repo because it ships a working starting agent. A composed example additionally proves that a worked strategy builds on the env layer. Every environment must ship at least one example, which CI composes and tests on every pull request.

## Adding an environment template

1. Add the environment to the environments package (see [Adding an environment](environments.md)).
2. Add one `TemplateEnvironmentSpec` to the static `TEMPLATE_ENVIRONMENTS` catalog in `scripts/_paths.py`. Put the environment's display name, inner package, import-self-contained module list, default-action export, and player slot in that spec. `scripts/generate.py` renders the uniform `sandbox.env` exports from the same spec, so there is no second registration map or runtime directory discovery. Include credited source and license files that must ship with the environment. Do not add Python human controllers or local renderers.
3. Create the `templates/<env>/` layer: at minimum a working starting `agent.py` (the naive agent the docs page builds) and a `README.md`, plus, when the observation or action needs decoding, a plain-Python helper module at `sandbox/<name>.py` and its pin test at `tests/test_<name>.py`. The base `sandbox/play.py` is environment-agnostic and starts the shared local browser server. Do not add environment-specific play overrides.
4. Run `scripts/generate.py` to sync `templates/<env>/sandbox/env/`.
5. Add at least one example under `examples/<env>/<name>/`, reading the observation through the helper module so it models the intended style.
6. Write the student documentation page `docs/students/environments/<env>.md` and add its row to the environments index. Compose ships this page inside the template as `environment.md`, the single source for the game's reference, so the template's `README.md` and `agent.py` point at it rather than restating it. The [student-facing deliverables](environments.md#student-facing-deliverables) section lists the required page sections, the helper placement rules, and the template docstring and README standards.

## Tags and publishing

Students use the separate `vox-deorum/game-agent-template` repository. Monorepo tags named `template-v<N>` identify dependency-set versions used by agent manifests.

`N` is one number wearing several hats (see `backend/src/deps-version.ts`): the `template-v<N>` release tag, the `deps-v<N>` session-image tag, and the `template_version` an agent manifest targets. A release keeps them in lockstep automatically. `scripts/bump_template_version.py` performs the bump and the `template-publish` workflow runs it, so the operator no longer hand-edits any version constant. On every pull request, CI's generated-code-fresh job runs `bump_template_version.py --check`, which fails if those touchpoints ever disagree. An active, unreleased `deps-v<N>` directory and its matching template may be regenerated together. Once `template-v<N>` is published, that dependency snapshot is immutable.

### Updating the version

`N` lives in several files that must always agree. `scripts/bump_template_version.py` owns every one of them, and CI runs `bump_template_version.py --check` on every pull request, so a hand-edit that desyncs them fails the pull request. There are only two files a contributor edits by hand, plus a set to leave alone.

To change the dependency set (the usual reason to bump), edit only these:

| File | What you do |
| --- | --- |
| `templates/base/requirements.in` | Declare the dependency intent. This is the single global set, shared by every environment layer. |
| `templates/base/requirements.txt` | Regenerate from `.in` with `uv pip compile`. Never hand-edit it, because it is the pinned closure the release freezes. |

Recompile after editing `requirements.in`:

```console
uv pip compile templates/base/requirements.in -o templates/base/requirements.txt --python-version 3.12
```

Leave the version touchpoints to the bump script. It writes all of them to the new `N` in one pass, so a hand-edit only risks drift:

| File | Held in sync by the script |
| --- | --- |
| `templates/base/manifest.json` (`template_version`) | The canonical value every composed template and example inherits. |
| `frontend/e2e/fixtures/submission/*/manifest.json` | Submitted against seasons seeded at the current version, so a stale value fails the e2e suite. |
| `backend/src/deps-version.ts` (`DEPS_VERSION`, `SESSION_BASE_IMAGES`) | The backend constant plus the registry entry for the new image directory. |
| `backend/images/session-base/deps-v<N>/` | A fresh frozen snapshot (requirements, Dockerfile, and built-in agents), created at release time. |

The number bump itself happens when you cut a release (below): the **Publish Template** workflow runs `bump_template_version.py`, which writes the four owned touchpoints to the new `N`. The one exception is the image directory. Hand-craft `backend/images/session-base/deps-v<N>/` in an ordinary pull request only when the image recipe itself must change (a new system library or a different base image); the bump script detects the existing directory, validates it, and leaves it untouched.

### Cutting a release

Dispatch the **Publish Template** workflow from `main` (Actions tab or `gh workflow run`) with the version input `N`:

- `N` greater than the current version **bumps** the repo to exactly `N`: `templates/base/manifest.json`, the `frontend/e2e/fixtures/submission/*` manifests, `DEPS_VERSION` and its `SESSION_BASE_IMAGES` registry entry, and a new frozen `backend/images/session-base/deps-v<N>/` snapshot (its `requirements.txt` frozen from the current `templates/base/requirements.txt`, the previous Dockerfile with its paths and version prose rewritten, and the built-in agents with bumped manifests).
- `N` equal to the current version **republishes the tree as-is** (the retry path after a partial failure, or a repo already bumped by hand).
- `N` less than the current version is **refused**, because publishing an older label would mislabel the release.

**Escape hatch:** when the image recipe itself must change (a new system library, a different base image), hand-craft `backend/images/session-base/deps-v<N>/` in an ordinary pull request first. The bump script detects an existing `deps-v<N>/`, leaves it untouched, and only validates it, so the deliberate snapshot wins over the mechanical copy.

### What the workflow does, in order

The workflow is a thin wrapper around `bump_template_version.py`, `scripts/compose.py`, and `scripts/publish_template.py`, the same code paths developers and CI use, so a student's clone is byte-identical to what CI tested. Its publish path uses Node to build the local frontend once before staging every template and example. It runs three jobs so that a failure anywhere leaves `main` and the tags untouched:

1. **verify** bumps the repo, commits that bump locally, and runs the full CI suite (`scripts/ci.py all`) on the exact release commit. That commit gets no other CI (a later bot push to `main` does not trigger `ci.yml`), so this job is its only gate. The commit is bundled as a workflow artifact for the next jobs.
2. **publish** checks out the bundled release commit and updates the student repository from it, so its `Template v<N> from game-sandbox@<sha>` message names the commit that will be tagged:
   - The **default environment's** composed template becomes the repository's `main` branch content, with a mirrored tag `v<N>`, so "Use this template" instantiates a runnable kit for the default game.
   - Each environment's composed template is force-pushed to an orphan branch `templates/<env>` (a fresh snapshot per release with no shared history).
   - Each example is composed and force-pushed to an orphan branch `examples/<env>/<name>`.
3. **push**, only after the student repo is fully updated, fast-forwards `main` to the release commit and, last of all, tags it `template-v<N>`.

Students pick an environment or example from the branch dropdown to browse or clone a complete, runnable agent repo.

**Recovery:** if `main` advances during a run, the fast-forward push fails and no tag is written, so the fix is to dispatch a fresh run (the student-repo publish force-pushes, so a partial attempt is overwritten cleanly). The `dry_run: true` input rehearses the entire path (bump, commit, full CI, local frontend build, and staged publish) while pushing nothing to the student repo, `main`, or tags. The publish script's own `--dry-run` flag does the same for a local run.

The new `deps-v<N>` image is not _built_ by this workflow (it has no Docker). Its first real build happens at the next Docker-gated run, so dispatch **e2e.yml** after a release to build the image and exercise the bumped fixtures against seeded seasons.

Versioning has two relevant axes:

- `schema_version` for breaking state-contract changes.
- `template-v<N>` for the global student dependency set.

The monorepo has no repository-wide semantic version.
