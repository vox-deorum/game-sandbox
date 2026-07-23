# Template Product and Releases

The student kit combines shared files with one environment's hand-authored layer and, optionally, a worked example.

```text
templates/base
      +
environments/<env>/template
      +
environments/<env>/examples/<name>   (optional)
      ->
complete runnable repository
```

Read [Environment template and examples](environments/template-and-examples.md) to create an environment layer. This page covers the composed product, its version, and publication.

## Composition

`scripts/compose.py <env>` copies `templates/base/` into `build/templates/<env>/`, generates the environment package, harness, and shared helpers into that output, and overlays the environment's `template/` directory.

`scripts/compose.py <env> <name>` then overlays `environments/<env>/examples/<name>/` into `build/examples/<env>/<name>/`.

Composition replaces whole files. `requirements.extra.txt` is the only merge: it appends pins and may not override one already in `requirements.txt`.

Compose copies the student environment page as `environment.md` and the shared LLM guide as `llm.md`, rewrites `{{DOCS_URL}}`, and fails if a required page or token is missing. The local browser bundle is added only to a release or dry-run staging tree.

## Versioned dependency set

One version number `N` identifies the `template-v<N>` tag, `deps-v<N>` session image, and each agent manifest's `template_version`.

`templates/base/manifest.json` is the canonical template value. `scripts/bump_template_version.py` updates every coupled touchpoint, and CI runs it with `--check` to catch drift.

Edit `templates/base/requirements.in` to change dependencies, then regenerate `templates/base/requirements.txt` with `uv pip compile`. Do not hand-edit the pinned file.

An active unreleased `deps-v<N>` directory may be regenerated with its matching template. Once `template-v<N>` is published, that snapshot is immutable.

## Cutting a release

Dispatch the Publish Template workflow from `main` with version `N`.

- A greater `N` creates the next dependency snapshot and updates the owned version touchpoints.
- The current `N` republishes the existing tree after a partial failure.
- A lower `N` is refused.

The workflow verifies the bumped commit, builds the local frontend once, and uses the same compose path as local checks. It then publishes the default template to the student repository's `main` branch, templates to `templates/<env>`, examples to `examples/<env>/<name>`, fast-forwards this repository's `main`, and writes `template-v<N>` last.

Use `dry_run: true` to rehearse the full path without pushing to the student repository, `main`, or tags. Run the Docker-gated end-to-end workflow after a release to build and exercise the new session image.
