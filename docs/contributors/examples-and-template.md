# Examples and the Template

The template is the complete student starter kit under `templates/`. An example under `examples/<name>/` holds only the files that differ from the template, so an example is a small reviewable diff against the template, not a second copy that can rot. The template's real content arrives in Stage 2; today it is a placeholder that proves the machinery.

## Composing an example

`scripts/compose_example.py <name>` copies `templates/**` into `build/examples/<name>/`, then copies `examples/<name>/**` on top with whole-file replacement, so an overlay file always wins. There is no manifest; the convention plus one merge rule is the whole mechanism.

The one merge rule: lines from the overlay's `requirements.extra.txt` are appended to the composed `requirements.txt`. Extras extend the dependency set; they never override it, so if a package is pinned in both, compose fails loudly. An example that needs a different pin is the spec's "ask the operator for a new template release" case in miniature. Deleting a template file from an example is not supported; a `.compose-delete` list is the documented escalation, deferred until something needs it.

## Why template updates propagate automatically

CI composes every example from the current `templates/` on every pull request and runs the composed example's tests in a fresh virtualenv. The template carries a pytest `tests/` directory and a `requirements-dev.txt`, so every composed example inherits them. A template change that breaks an example fails the pull request that made the change, not some later discovery. This is the entire reason for the overlay design.

## Tags and publishing

Students never clone the monorepo. They use a separate student-facing repository, `vox-deorum/game-agent-template`, marked as a GitHub template repository. Template releases are tags `template-v<N>` on the monorepo, where N is a monotonic integer equal to the dependency-set version that agent manifests reference. `template-v0` is the Stage 1 placeholder; the first real set is `template-v1`, cut in Stage 2.

When a maintainer pushes a `template-v<N>` tag, the publish workflow updates the student repository in two ways. The template becomes its main branch content, committed as `Template v<N> from game-sandbox@<sha>` with a mirrored tag `v<N>`. Each example is composed and force-pushed to an orphan branch named `examples/<name>` on the same repository, a fresh snapshot per release with no shared history. Students pick an example from the branch dropdown to browse or clone a complete, runnable agent repo.

The publish workflow contains no composition logic of its own: it is a thin wrapper around the same `scripts/compose_example.py` and `scripts/publish_template.py` that developers and CI use, so the example a student clones is byte-identical to the one CI tested. The publish script takes a `--dry-run` flag that does everything except push, which is how the tag-to-publish path is rehearsed locally without touching the student repository.

The project's whole versioning story has three axes and nothing else: the `schema_version` integer bumps only on breaking contract changes; the `template-v<N>` tags version the dependency set and are the only release tags the monorepo carries; and there are no repo-wide semver releases, because nothing is published to PyPI or npm.
