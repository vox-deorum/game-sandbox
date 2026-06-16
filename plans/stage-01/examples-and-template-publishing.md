# Stage 1: Examples, the Template, and Publishing

Part of [Stage 1](../stage-01-contracts.md). This file describes how examples stay in lockstep with the template, how versions are cut, and how both reach students. The template's real content arrives in Stage 2 per [stage-02](../stage-02-harness-and-first-environment.md); Stage 1 builds and proves the machinery with a placeholder.

## Where everything lives

The template source and all example sources live in this monorepo. `templates/` is the student starter kit, organised as two layers: an env-agnostic `templates/base/` and one `templates/<env>/` layer per environment. The design grows in Stage 2 (see [stage-02/template-and-examples.md](../stage-02/template-and-examples.md)). A complete template for an environment is `base` plus its env layer, composed. Each example under `examples/<env>/<name>/` contains only the files that differ from its composed template: typically the agent implementation, a README, and optionally a `requirements.extra.txt` with extra pinned dependencies. An example is therefore a small, reviewable diff, not a second copy that can rot.

## How a template or example becomes runnable

`scripts/compose.py <env>` copies `templates/base/**` into the gitignored `build/templates/<env>/`, then copies `templates/<env>/**` on top with whole-file replacement, so an env-layer file always wins. `scripts/compose.py <env> <name>` composes that template, then overlays `examples/<env>/<name>/**` on top the same way into `build/examples/<env>/<name>/`. There is no manifest. The convention plus one merge rule is the whole mechanism.

The one merge rule: lines from an example's `requirements.extra.txt` are appended to the composed `requirements.txt`, and if a package is pinned in both, compose fails loudly. Extras extend the dependency set; they never override it. An example that needs a different pin is the spec's "ask the operator for a new template release" case in miniature. The dependency set is global and lives only in `base/`, so env layers carry no requirements files (compose rejects one that does). Deleting a base file from an env layer or example is not supported. If one ever needs it, a `.compose-delete` list is the documented escalation, deferred until then.

## Why template updates propagate automatically

CI composes every example from the current `templates/` on every pull request and runs the composed example's tests. The base layer carries a pytest-runnable `tests/` directory and a `requirements-dev.txt`, so every composed example inherits them. CI installs each composed example into a fresh uv venv and runs pytest there. A template change that breaks an example fails the PR that made the change, not some later discovery. This is the entire reason for the overlay design. Because the bare template's `act` raises `NotImplementedError`, the composed example is the only green proof per environment, so CI also requires every env layer to ship at least one example.

## How students consume the results

Students never clone the monorepo. They use a separate student-facing repository, `vox-deorum/game-agent-template`, marked as a GitHub template repository so "Use this template" works. When a maintainer pushes a `template-v<N>` tag on the monorepo, the publish workflow updates that repository:

- The default environment's composed template becomes its main branch content, so "Use this template" instantiates a runnable kit. It is committed as `Template v<N> from game-sandbox@<sha>` with a mirrored tag `v<N>`.
- Each environment's composed template is force-pushed to a `templates/<env>` branch, and each example to an `examples/<env>/<name>` branch.

These are snapshot branches with no shared history with main (git calls this an orphan branch). A composed template or example is a generated artifact, so each release simply replaces the branch with a fresh snapshot. Students pick an environment or example from the branch dropdown to browse it or clone a complete, runnable agent repo.

Branches were chosen over one repository per environment or example because students need to browse and clone them, not all instantiate them. A single repository keeps administration, tokens, and discovery in one place, and at class scale a handful of `templates/*` and `examples/*` branches is not clutter.

## One compose path everywhere

The publish workflow does not contain composition logic of its own. Its jobs are thin wrappers around the same scripts developers and CI use. `scripts/compose.py` builds each template and example, and `scripts/publish_template.py` performs the content replacement, commits, tags, and pushes for the main branch and the template and example branches. Local development, CI verification, and publishing all exercise one code path, so the artifact a student clones is byte-identical to the one CI tested, and the whole pipeline can be run and debugged locally given a token. The publish script also takes a dry-run flag that does everything except push. That is how the tag-to-publish path is rehearsed locally without touching the student repository (see [testing-and-ci.md](testing-and-ci.md)).

## Tags and versioning

Template releases are tags `template-v<N>` on the monorepo, where N is a monotonic integer equal to the dependency-set version that agent manifests reference. `template-v0` is reserved for the Stage 1 placeholder; the first real set is `template-v1`, cut in Stage 2. The integer-only choice mirrors the schema version reasoning in [state-schema.md](state-schema.md).

The project's whole versioning story has three axes and nothing else:

- The `schema_version` integer bumps only on breaking contract changes.
- The `template-v<N>` tags version the dependency set and are the only release tags the monorepo carries.
- There are no repo-wide semver releases, because nothing is published to PyPI or npm.

## The publish workflow

`.github/workflows/template-publish.yml` is triggered manually (`workflow_dispatch`) with a single `version` input N, not by a tag push, and runs three jobs in order. The tag is deliberately the workflow's last action rather than its trigger. If the `template-v<N>` tag were the trigger, a run that failed partway would leave a dangling release tag that has to be deleted before any retry. Inverting it makes the tag a record of a completed publish, so a failure leaves nothing to clean up and recovery is simply to re-run.

The three jobs are:

1. **Verify.** Reject a non-integer version, or one whose tag already exists (you bump N rather than re-release). Then compose and test all examples at this commit, so a broken or already-released state cannot publish.
2. **Publish.** A single `scripts/publish_template.py --tag template-v<N>` run publishes the default environment's composed template to the student repository's main branch with the mirrored `v<N>` tag, then force-pushes each environment's composed template to its `templates/<env>` branch and each composed example to its `examples/<env>/<name>` branch. This is one script invocation sharing the one compose path, so the published artifact is provably identical to what verify tested, and force-pushing means a partial previous attempt is overwritten cleanly.
3. **Tag.** Only once the student repo is fully updated, stamp this monorepo commit with the `template-v<N>` tag.

The two halves of the publish step touch two different repositories' tags. The mirrored `v<N>` on the student repo is part of the published artifact, while the `template-v<N>` on the monorepo is the release marker created by the final job. The student-repo push authenticates with a fine-grained personal access token holding contents write on the target repository. That token is stored as the `TEMPLATE_REPO_TOKEN` secret on a dedicated `template-publish` environment that only the publish job opts into, so it is gated behind environment protection rules and never exposed to the verify or tag jobs. A GitHub App is the documented upgrade if token rotation becomes a burden. The final monorepo tag uses the workflow's own `GITHUB_TOKEN` with contents write scoped to that job alone. Marking the target as a GitHub template repository is a one-time manual setting.

## What "proven" means in Stage 1

Stage 1 ships a placeholder template made of:

- a README with a visible warning that the real template arrives in Stage 2,
- a pinned `requirements.txt` with at least one real dependency (`attrs`),
- a `requirements-dev.txt` (`pytest`),
- a trivial `agent.py` module,
- a root `conftest.py` so pytest puts the composed example root on `sys.path` for `import agent`,
- and a passing `tests/`.

Alongside it, the `hello` example overrides `agent.py`, adds one extra pinned dependency (`wcwidth`) through `requirements.extra.txt`, and adds one example-specific test.

The machinery is proven when all of the following hold:

- Running the publish workflow for v0 updates the student repository's main branch, its `v0` tag, and the example branch end to end, then stamps the monorepo's `template-v0` tag.
- Regular CI composes and tests the example on every PR.
- A unit test asserts the conflicting-pin failure mode.

The composition, the conflicting-pin failure, the composed-example test run, and the publish dry-run are all verified locally. The live publish run is the one remaining external step.
