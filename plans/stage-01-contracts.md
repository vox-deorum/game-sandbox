# Stage 1: Contracts and Repo Skeleton

Status: complete, with GitHub Pages deployment deferred. Everything that can be built and verified locally is done: the repo skeleton and tooling, the two schema files, the `harness` package, `scripts/generate.py`, the `schema/ts` package, all three CI workflows, the docs site, and the template, `examples/hello`, compose script, and publish script. The cross-language round trip, the staleness/determinism check, the strict docs build, the composed-example tests, and the publish dry-run all pass. They run as one command (`scripts/ci.py all`). All six workflow jobs have also been run green in containers with `act`. The full publish pipeline has now run for real. The `template-publish` workflow, dispatched for v0, published the placeholder template to `vox-deorum/game-agent-template` (its `main` branch and mirrored `v0` tag) and the composed `hello` example to its `examples/hello` branch, then stamped the `template-v0` tag on this monorepo. The `TEMPLATE_REPO_TOKEN` secret lives on the `template-publish` environment. Only the `publish` job declares that environment, so the token stays gated behind environment protection rules and out of every other job. One piece is held back: GitHub Pages. The docs site is not public yet, so the `deploy` job in `docs.yml` is temporarily disabled while the strict `build` job keeps running on every push and PR. The remaining step is to enable Pages with the GitHub Actions source and re-enable `deploy`, done when the site goes public.

## Goal

Establish the shapes everything else is built against, plus the delivery machinery every later stage inherits. The shapes are the repository layout, the versioned per-step state schema shared by Python and TypeScript, the recording file format, and the versioning rules later sidecars use. The machinery is workspace tooling for both languages, the documentation site, example composition over the template, and the pipeline that publishes the template to the student-facing repository. At the end of this stage there is no game yet. But both sides of the container boundary produce and consume the same payloads, and every later stage lands on working CI, docs, and release mechanics.

## Plan documents

The detailed design lives under [stage-01/](stage-01/):

- [repo-and-tooling.md](stage-01/repo-and-tooling.md): monorepo layout, uv and npm workspaces, tool choices, dev scripts.
- [state-schema.md](stage-01/state-schema.md): the two schema files, integer version semantics, the sidecar rule.
- [codegen-and-recording.md](stage-01/codegen-and-recording.md): TypeScript codegen and Ajv guards, Python jsonschema validation, staleness checks, the recording store.
- [docs-site.md](stage-01/docs-site.md): docs topics for students and contributors, MkDocs Material, Pages publishing.
- [examples-and-template-publishing.md](stage-01/examples-and-template-publishing.md): overlay composition, template tags, the publish workflow to the student repo.
- [testing-and-ci.md](stage-01/testing-and-ci.md): per-package tests, the cross-language round trip, the workflow set, reproducing CI locally under WSL.

## Scope

Set up the monorepo with uv workspaces for Python and npm workspaces for TypeScript: `schema/`, `harness/`, and placeholder directories for `environments/`, `backend/`, `frontend/`, `templates/`, and `gateway/`, plus `docs/` and `scripts/`. Tooling on the Python side is ruff, pytest, and pyright. On the TypeScript side it is Biome, Vitest, and strict tsc. Details in [repo-and-tooling.md](stage-01/repo-and-tooling.md).

Define the per-step state object as a JSON Schema (draft 2020-12) with an explicit integer `schema_version`. It covers the fields named in [interaction.md](../docs/specs/interaction.md): tick number, per-agent display observations, actions, rewards, cumulative scores, environment-specific overlay fields, messages, and timing. Messages and overlay fields are present from day one, even though messaging arrives in Stage 8, so the schema needs no breaking revision later. The version bumps only on breaking changes. Additive growth happens in documented open regions. Details in [state-schema.md](stage-01/state-schema.md).

Wire up code generation and validation, per [execution.md](../docs/specs/execution.md). On the TypeScript side, generate types from the schema with Ajv runtime guards so reads need no hand-written casts. On the Python side, run jsonschema validation against every payload the harness emits. A CI check fails when anything generated (types, packaged schema copies, fixtures) is stale relative to the schema. Details in [codegen-and-recording.md](stage-01/codegen-and-recording.md).

Define the recording format from [recording.md](../docs/specs/recording.md) as JSONL: a header line naming the environment and the schema version, then one per-step state per line. The spec also has the header carry per-slot attribution (who or what drove each slot); that field is deferred to the multi-agent stage, where slots become meaningful, and is not part of the single-agent Stage 1 header. This is the same line-delimited JSON the harness streams over its transport in Stage 3, so the wire form and the stored form are a single format. Inbound control commands are a separate Stage 3 envelope, not recording lines. The header defines how optional sidecars attach. Implement a minimal Python save and load interface against a folder on disk, shaped so an S3-compatible backend can be added behind it later. Details in [codegen-and-recording.md](stage-01/codegen-and-recording.md).

Stand up the documentation site: topic-based Markdown in `docs/` with separate student and contributor sections. The specification is rendered as a third section directly from `specs/`, so it is never duplicated. Everything is rendered with MkDocs Material, built strictly on PRs, and published to GitHub Pages on merge to main. Details in [docs-site.md](stage-01/docs-site.md).

Build the example and template machinery with an environment-agnostic base layer, ahead of the real environment content in Stage 2. Each environment later keeps its hand-authored template layer and example overlays beside its package under `environments/<env>/`. A compose script combines those tracked layers and generates the environment package, harness, and shared helpers directly in build output. CI tests every composed example on every PR, so template changes propagate automatically. A manually triggered workflow publishes templates and examples to the student-facing repository using the same compose script, and tags the release on success. Details in [examples-and-template-publishing.md](stage-01/examples-and-template-publishing.md).

## Spec references

[execution.md](../docs/specs/execution.md) (the schema as the cross-boundary contract, implementation languages), [interaction.md](../docs/specs/interaction.md) (per-step state object), [recording.md](../docs/specs/recording.md) (header, format, and sidecar placement), [submission.md](../docs/specs/submission.md) (template repos and dependency-set versioning).

## Depends on

Nothing. This is the first stage.

## Done when

A round-trip test passes in CI. Python constructs a per-step state object and a two-step recording, validates them against the schema, and writes them to disk. TypeScript reads them back through the generated types with no hand-written casts. Bumping the schema version in a test fixture is detected by both sides. A fixture with an unknown optional sidecar is ignored according to the documented rule rather than corrupting the recording.

The machinery has its own criteria. The docs site builds strictly in CI and, once the site is public and the `deploy` job is re-enabled, publishes to GitHub Pages on merge to main. Running the publish workflow for v0 publishes the placeholder template to the student repository and the composed `hello` example to its `examples/hello` branch end to end, then stamps the `template-v0` tag on success. The `hello` example composes and passes its tests in regular CI, including the test that a conflicting dependency pin fails composition loudly.

## Build order

1. Repo skeleton: directories, placeholder READMEs, root workspace configs, tool configs. No code.
2. Author the two schema files and the `schema/README.md` pointer.
3. The `harness/` package: validators, state builders, the recording store protocol and folder implementation, with tests.
4. `scripts/generate.py`: TypeScript types, packaged schema copies, golden fixtures through the real store.
5. The `schema/ts` package: Ajv guards, `readRecording`, and vitest over the committed fixtures. The round trip now exists locally.
6. `ci.yml` with its four jobs; the round trip and staleness checks are now enforced.
7. The docs skeleton, the five real contributor pages, `mkdocs.yml`, `docs.yml`, and Pages setup. Can run in parallel with 3 through 6.
8. The placeholder template, the `flappy_bird/hello` example, the compose script with its tests, and the examples CI job. Can run in parallel with 5.
9. Create the student repository, mark it as a template repository, mint the token secret, and add `template-publish.yml` with its publish script.
10. Run the publish workflow manually for v0, verify the full pipeline end to end (it tags `template-v0` on success), fix what breaks.
11. Keep this file and the stage-01 documents in sync with whatever the implementation confirms or changes, per the [plan rules](README.md).

## Open questions

The student repository name is settled: `vox-deorum/game-agent-template` exists. GitHub Pages is no longer a Stage 1 question. Deployment is deferred until the site is public, so enabling it moves with that. The cross-repo push uses a fine-grained personal access token (Contents: read/write, scoped to the single target repository), stored as the `TEMPLATE_REPO_TOKEN` secret on the `template-publish` environment that the `publish` job opts into. Revisit a GitHub App if rotation becomes a burden. Slot id string conventions are deferred to Stage 2, when real PettingZoo agent ids exist.
