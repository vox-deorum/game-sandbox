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

Read [Environment template and examples](template-and-examples.md) to create an environment layer. This page covers the composed product, its version, and publication.

## Composition

`scripts/compose.py <env>` copies `templates/base/` into `build/templates/<env>/`, generates the environment package, harness, and shared helpers into that output, and overlays the environment's `template/` directory.

Composition is intentionally disposable. Recompose every template and example after changing environment metadata, gameplay parameter declarations, the harness launch contract, or the generated factory signature. Outputs composed from another checkout are unsupported.

`scripts/compose.py <env> <name>` then overlays `environments/<env>/examples/<name>/` into `build/examples/<env>/<name>/`.

Composition replaces whole files. The only merged file is `requirements.extra.txt`: it appends pins but cannot override a pin already in `requirements.txt`.

An environment's `PUBLISHED_EXAMPLES` tuple selects the source examples published as public branches. It does not affect `compose.py` or examples CI: every checked-in example remains composable and tested. An empty tuple publishes no example branches for that environment.

Compose copies the canonical `environments/<env>/environment.md` guide into each kit as `environment.md`, alongside the shared LLM guide as `llm.md`. It rewrites `{{DOCS_URL}}` and fails if a required guide or token is missing. MkDocs exposes the same guide as a dynamically discovered virtual page under `students/environments/<slug>.md`. The local browser bundle is added only to a release or dry-run staging tree.

## Versioned dependency set

One version number, `N`, identifies the `template-v<N>` tag, the `deps-v<N>` session image, and each agent manifest's `template_version`.

`templates/base/manifest.json` is the canonical template value. `scripts/bump_template_version.py` updates every coupled touchpoint, and CI runs it with `--check` to catch drift.

Edit `templates/base/requirements.in` to change dependencies, then regenerate `templates/base/requirements.txt` with `uv pip compile`. Do not hand-edit the pinned file.

An active, unreleased `deps-v<N>` directory may be regenerated with its matching template. Once `template-v<N>` is published, its snapshot is immutable. A republish reuses the unchanged `deps-v<N>` snapshot because CI pins every dependency reference to it.

## Cutting a release

Dispatch the Publish Template workflow from `main` with version `N`.

- A greater `N` creates the next dependency snapshot and updates the owned version touchpoints.
- The current `N` retries a release whose `template-v<N>` tag never landed.
- The current `N` with `republish: true` refreshes an already-tagged release. It reruns CI on the current `main`, force-pushes the student repository, and does not change this repository's `main` or its `template-v<N>` tag. Use it to publish an environment merged after `template-v<N>` shipped.
- A lower `N` is refused.

The workflow verifies the selected commit, builds the local frontend once, and uses the same composition path as local checks. It publishes the default template to the student repository's `main` branch, environment templates to `templates/<env>`, and selected examples to `examples/<env>/<name>`. After pushing every desired branch, a real publish removes generated `examples/*` branches that are no longer in `PUBLISHED_EXAMPLES`. Other branches are unaffected. A normal release then fast-forwards this repository's `main` and writes `template-v<N>` last. A republish skips both operations.

Use `dry_run: true` to rehearse the full path without contacting or mutating the student repository, `main`, or tags. Combine `dry_run: true` with `republish: true` to rehearse a republish. Run the Docker-gated end-to-end workflow after a release to build and exercise the new session image.
