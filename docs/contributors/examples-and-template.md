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

`templates/base/` contains the shared manifest, dependencies, and tests, plus the provided tooling under `sandbox/` (the `sandbox.play`/`sandbox.evaluate` scripts and the `python -m sandbox` helper). `templates/<env>/` adds the environment stub (`agent.py`) and the generated local game package under `sandbox/env/`. A student edits only `agent.py` at the repository root; everything under `sandbox/` is provided. An example stores only its differences from the composed template.

This keeps shared files in one place and examples small enough to review.

## Composing

`scripts/compose.py` composes in one or two steps:

- `scripts/compose.py <env>` copies `templates/base/**` into `build/templates/<env>/`, then overlays `templates/<env>/**` on top with whole-file replacement, so an env-layer file always wins.
- `scripts/compose.py <env> <name>` composes that template, then overlays `examples/<env>/<name>/**` on top, again whole-file.
- `scripts/compose.py` with no arguments lists the known environments and examples.

Composition uses whole-file replacement. The only special merge is `requirements.extra.txt`, whose lines append to `requirements.txt`. An extra may not override an existing pin.

The dependency set is global and versioned as `template-v<N>`. Environment layers cannot include requirements files. File deletion during composition is not supported until a real need justifies a deletion manifest.

There is no separate composition manifest. Directory conventions, whole-file overlays, and the one dependency-extension rule are the complete mechanism, which keeps a composed repository easy to inspect.

## Why template updates propagate automatically

CI composes every example from the current `templates/` on every pull request and runs the composed example's tests in a fresh virtualenv. The base layer carries a pytest `tests/` directory and a `requirements-dev.txt`, so every composed example inherits them. A base or env-layer change that breaks an example fails the pull request that made the change, not some later discovery. This is the entire reason for the overlay design.

The bare template test fails until the student implements `act`. A composed example is therefore the green end-to-end proof. Every environment must ship at least one example.

## Adding an environment template

1. Add the environment to the environments package (see [Adding an environment](environments.md)).
2. Register it in `scripts/_paths.py` `TEMPLATE_ENVS` (env id → the import-self-contained modules to sync) and add its generated `__init__` texts in `scripts/generate.py`. The top-level `sandbox/env/__init__.py` must expose the uniform surface the provided scripts read: `make_env`, `ENV_ID`, `PLAYER_SLOT`, and `make_human_controller`. To make the environment human-playable, include its `human.py` (the `make_human_controller` factory) in the `TEMPLATE_ENVS` entry so it syncs alongside the env modules.
3. Create the `templates/<env>/` layer: at minimum an `agent.py` stub and a `README.md`. The base `sandbox/play.py` is environment-agnostic; override it whole-file in the env layer only if the local loop does not fit.
4. Run `scripts/generate.py` to sync `templates/<env>/sandbox/env/`.
5. Add at least one example under `examples/<env>/<name>/`.

## Tags and publishing

Students use the separate `vox-deorum/game-agent-template` repository. Monorepo tags named `template-v<N>` identify dependency-set versions used by agent manifests.

The publish workflow verifies examples, updates the student repository, then creates the monorepo tag:

- The **default environment's** composed template becomes the repository's `main` branch content, committed as `Template v<N> from game-sandbox@<sha>` with a mirrored tag `v<N>`, so "Use this template" instantiates a runnable kit for the default game.
- Each environment's composed template is force-pushed to an orphan branch `templates/<env>` (a fresh snapshot per release with no shared history).
- Each example is composed and force-pushed to an orphan branch `examples/<env>/<name>`.

Students pick an environment or example from the branch dropdown to browse or clone a complete, runnable agent repo. The publish workflow contains no composition logic of its own: it is a thin wrapper around the same `scripts/compose.py` and `scripts/publish_template.py` that developers and CI use, so the artifact a student clones is byte-identical to the one CI tested. The publish script takes a `--dry-run` flag that does everything except push, which is how the tag-to-publish path is rehearsed locally without touching the student repository.

Versioning has two relevant axes:

- `schema_version` for breaking state-contract changes.
- `template-v<N>` for the global student dependency set.

The monorepo has no repository-wide semantic version.
