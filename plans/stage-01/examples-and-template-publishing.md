# Stage 1: Examples, the Template, and Publishing

Part of [Stage 1](../stage-01-contracts.md). This file describes how examples stay in lockstep with the template, how versions are cut, and how both reach students. The template's real content arrives in Stage 2 per [stage-02](../stage-02-harness-and-first-environment.md); Stage 1 builds and proves the machinery with a placeholder.

## Where everything lives

The template source and all example sources live in this monorepo. `templates/` is the complete student starter kit. Each example under `examples/<name>/` contains only the files that differ from the template: typically the agent implementation, a README, and optionally a `requirements.extra.txt` with extra pinned dependencies. An example is therefore a small, reviewable diff against the template, not a second copy of it that can rot.

## How an example becomes runnable

`scripts/compose_example.py <name>` copies `templates/**` into the gitignored `build/examples/<name>/`, then copies `examples/<name>/**` on top with whole-file replacement, so an overlay file always wins. There is no manifest; the convention plus one merge rule is the whole mechanism. The one merge rule: lines from the overlay's `requirements.extra.txt` are appended to the composed `requirements.txt`, and if a package is pinned in both, compose fails loudly. Extras extend the dependency set, they never override it; an example that needs a different pin is the spec's "ask the operator for a new template release" case in miniature. Deleting a template file from an example is not supported; if an example ever needs it, a `.compose-delete` list is the documented escalation, deferred until then.

## Why template updates propagate automatically

CI composes every example from the current `templates/` on every pull request and runs the composed example's tests. The template carries a pytest-runnable `tests/` directory and a `requirements-dev.txt`, so every composed example inherits them; CI installs each composed example into a fresh uv venv and runs pytest there. A template change that breaks an example fails the PR that made the change, not some later discovery. This is the entire reason for the overlay design.

## How students consume the results

Students never clone the monorepo. They use a separate student-facing repository, `vox-deorum/game-agent-template`, marked as a GitHub template repository so "Use this template" works. When a maintainer pushes a `template-v<N>` tag on the monorepo, the publish workflow updates that repository in two ways. The template itself becomes its main branch content, committed as `Template v<N> from game-sandbox@<sha>` with a mirrored tag `v<N>`. Each example is composed and force-pushed to a branch named `examples/<name>` on the same repository. These are snapshot branches with no shared history with main (git calls this an orphan branch): a composed example is a generated artifact, so each release simply replaces the branch with a fresh snapshot. Students pick an example from the branch dropdown to browse it or clone a complete, runnable agent repo.

Branches were chosen over one repository per example because students need to browse and clone examples, not instantiate them; a single repository keeps administration, tokens, and discovery in one place, and at class scale a handful of `examples/*` branches is not clutter.

## One compose path everywhere

The publish workflow does not contain composition logic of its own. Its jobs are thin wrappers around the same scripts developers and CI use: `scripts/compose_example.py` builds each example, and `scripts/publish_template.py` performs the content replacement, commits, tags, and pushes for both the template and the example branches. Local development, CI verification, and publishing all exercise one code path, so the example a student clones is byte-identical to the one CI tested, and the whole pipeline can be run and debugged locally given a token. The publish script also takes a dry-run flag that does everything except push, which is how the tag-to-publish path is rehearsed locally (see [testing-and-ci.md](testing-and-ci.md)) without touching the student repository.

## Tags and versioning

Template releases are tags `template-v<N>` on the monorepo, where N is a monotonic integer equal to the dependency-set version that agent manifests reference. `template-v0` is reserved for the Stage 1 placeholder; the first real set is `template-v1`, cut in Stage 2. The integer-only choice mirrors the schema version reasoning in [state-schema.md](state-schema.md).

The project's whole versioning story has three axes and nothing else. The `schema_version` integer bumps only on breaking contract changes. The `template-v<N>` tags version the dependency set and are the only release tags the monorepo carries. There are no repo-wide semver releases, because nothing is published to PyPI or npm.

## The publish workflow

`.github/workflows/template-publish.yml` triggers on pushed tags matching `template-v*` and runs two jobs in order. First, verify: compose and test all examples at the tagged commit, so a broken state cannot publish. Second, publish: a single `scripts/publish_template.py` run that publishes the template content to the student repository's main branch with the mirrored tag and then force-pushes each composed example to its `examples/<name>` branch. The publish work is one script invocation rather than two separate jobs because both halves share the one compose path and the same token, and keeping them in one process keeps the published artifact provably identical to what verify tested. Authentication uses a fine-grained personal access token with contents write on the target repository, stored as the `TEMPLATE_REPO_TOKEN` secret on a dedicated `template-publish` environment that the publish job opts into, so the token is gated behind environment protection rules and never exposed to the verify job; a GitHub App is the documented upgrade if token rotation becomes a burden. Marking the target as a GitHub template repository is a one-time manual setting.

## What "proven" means in Stage 1

Stage 1 ships a placeholder template: a README with a visible warning that the real template arrives in Stage 2, a pinned `requirements.txt` with at least one real dependency (`attrs`), a `requirements-dev.txt` (`pytest`), a trivial `agent.py` module, a root `conftest.py` so pytest puts the composed example root on `sys.path` for `import agent`, and a passing `tests/`. Alongside it, `examples/hello/` overrides `agent.py`, adds one extra pinned dependency (`wcwidth`) through `requirements.extra.txt`, and adds one example-specific test. The machinery is proven when pushing `template-v0` updates the student repository's main branch, its `v0` tag, and the `examples/hello` branch end to end; when regular CI composes and tests the example on every PR; and when a unit test asserts the conflicting-pin failure mode. The composition, the conflicting-pin failure, the composed-example test run, and the publish dry-run are all verified locally; the live tag push is the one remaining external step.
