# Examples and the Template

The student starter kit lives under `templates/` as two kinds of layer. `templates/base/` is the env-agnostic foundation — the manifest, the global pinned dependency set, the play/evaluate/LLM scripts, and the inherited `tests/`. `templates/<env>/` is a per-environment layer holding only what is specific to that environment: its `agent.py` stub, its README, and its generated `sandbox_env/`. A complete template for an environment is `base` plus that one env layer, composed. An example under `examples/<env>/<name>/` holds only the files that differ from its composed template, so an example is a small reviewable diff, not a copy that can rot.

This two-layer shape lets one repo carry many environments. The shared pieces are written once in `base`; each new environment is a sibling directory under `templates/`, not a forked copy of the whole kit.

## Composing

`scripts/compose.py` composes in one or two steps:

- `scripts/compose.py <env>` copies `templates/base/**` into `build/templates/<env>/`, then overlays `templates/<env>/**` on top with whole-file replacement, so an env-layer file always wins.
- `scripts/compose.py <env> <name>` composes that template, then overlays `examples/<env>/<name>/**` on top, again whole-file.
- `scripts/compose.py` with no arguments lists the known environments and examples.

There is no manifest; the convention plus one merge rule is the whole mechanism. The one merge rule: lines from an example's `requirements.extra.txt` are appended to the composed `requirements.txt`. Extras extend the dependency set; they never override it, so if a package is pinned in both, compose fails loudly. An example that needs a different pin is the spec's "ask the operator for a new template release" case in miniature.

The dependency set is **global**: a single `requirements.in`/`requirements.txt` in `templates/base/`, the union of what every environment needs, versioned by the single `template-v<N>` axis. Environment layers therefore never carry requirements files, and compose rejects an env layer that does. Deleting a base file from an env layer or example is not supported; a `.compose-delete` list is the documented escalation, deferred until something needs it.

## Why template updates propagate automatically

CI composes every example from the current `templates/` on every pull request and runs the composed example's tests in a fresh virtualenv. The base layer carries a pytest `tests/` directory and a `requirements-dev.txt`, so every composed example inherits them. A base or env-layer change that breaks an example fails the pull request that made the change, not some later discovery. This is the entire reason for the overlay design.

Because the bare template's pytest is red by design — `agent.py` raises `NotImplementedError` until a student implements it — a composed example is the only green proof that an environment layer works end to end. CI enforces the rule that **every environment layer ships at least one example**.

## Adding an environment template

1. Add the environment to the environments package (see [Adding an environment](environments.md)).
2. Register it in `scripts/_paths.py` `TEMPLATE_ENVS` (env id → the import-self-contained modules to sync) and add its generated `__init__` texts in `scripts/generate.py`. The top-level `sandbox_env/__init__.py` must expose the uniform surface the base scripts read: `make_env`, `ENV_ID`, and `PLAYER_SLOT`.
3. Create the `templates/<env>/` layer: at minimum an `agent.py` stub and a `README.md`. If the base `play.py` does not fit the environment's local loop, override it whole-file in the env layer.
4. Run `scripts/generate.py` to sync `templates/<env>/sandbox_env/`.
5. Add at least one example under `examples/<env>/<name>/`.

## Tags and publishing

Students never clone the monorepo. They use a separate student-facing repository, `vox-deorum/game-agent-template`, whose branches carry the per-environment templates and examples. Template releases are tags `template-v<N>` on the monorepo, where N is a monotonic integer equal to the dependency-set version that agent manifests reference. `template-v0` is the Stage 1 placeholder; the first real set is `template-v1`, cut in Stage 2.

When a maintainer pushes a `template-v<N>` tag, the publish workflow updates the student repository:

- The **default environment's** composed template becomes the repository's `main` branch content, committed as `Template v<N> from game-sandbox@<sha>` with a mirrored tag `v<N>`, so "Use this template" instantiates a runnable kit for the default game.
- Each environment's composed template is force-pushed to an orphan branch `templates/<env>` (a fresh snapshot per release with no shared history).
- Each example is composed and force-pushed to an orphan branch `examples/<env>/<name>`.

Students pick an environment or example from the branch dropdown to browse or clone a complete, runnable agent repo. The publish workflow contains no composition logic of its own: it is a thin wrapper around the same `scripts/compose.py` and `scripts/publish_template.py` that developers and CI use, so the artifact a student clones is byte-identical to the one CI tested. The publish script takes a `--dry-run` flag that does everything except push, which is how the tag-to-publish path is rehearsed locally without touching the student repository.

The project's whole versioning story has three axes and nothing else: the `schema_version` integer bumps only on breaking contract changes; the `template-v<N>` tags version the (global) dependency set and are the only release tags the monorepo carries; and there are no repo-wide semver releases, because nothing is published to PyPI or npm.
