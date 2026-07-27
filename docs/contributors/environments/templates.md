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

The [`PUBLISHED_EXAMPLES` allowlist](template-and-examples.md#hand-authored-layers) selects which examples the publish step turns into public branches.

Compose copies the canonical `environments/<env>/environment.md` guide into each kit as `environment.md`, alongside the shared LLM guide as `llm.md`. It rewrites `{{DOCS_URL}}` and fails if a required guide or token is missing. The local browser bundle is added only to a release or dry-run staging tree.

## Versioned dependency set

One version number, `N`, identifies the `template-v<N>` tag, the `deps-v<N>` session image, and each agent manifest's `template_version`.

`templates/base/manifest.json` is the canonical template value. `scripts/bump_template_version.py` updates every coupled touchpoint, and CI runs it with `--check` to catch drift.

Edit `templates/base/requirements.in` to change dependencies, then regenerate `templates/base/requirements.txt` with `uv pip compile`. Do not hand-edit the pinned file.

An active, unreleased `deps-v<N>` directory may be regenerated with its matching template. Once `template-v<N>` is published, its snapshot is immutable. A [republish](#cutting-a-release) reuses the unchanged `deps-v<N>` snapshot because CI pins every dependency reference to it.

## Cutting a release

Dispatch the Publish Template workflow from `main` with version `N`.

- A greater `N` creates the next dependency snapshot and updates the owned version touchpoints.
- The current `N` retries a release whose `template-v<N>` tag never landed.
- The current `N` with `republish: true` refreshes an already-tagged release from the current `main`, force-pushing the student repository. Use it to publish an environment merged after `template-v<N>` shipped.
- A lower `N` is refused.

The workflow verifies the selected commit, builds the local frontend once, and uses the same composition path as local checks. It publishes the default template to the student repository's `main` branch, environment templates to `templates/<env>`, and selected examples to `examples/<env>/<name>`. After pushing every desired branch, a real publish removes generated `examples/*` branches that are no longer in `PUBLISHED_EXAMPLES` and leaves other branches unaffected.

The two release forms differ only in their final steps:

| Final step                            | Normal release | Republish |
| ------------------------------------- | -------------- | --------- |
| Fast-forward this repository's `main` | Yes            | No        |
| Write the `template-v<N>` tag         | Yes            | No        |

Use `dry_run: true` to rehearse the full path without contacting or mutating the student repository, `main`, or tags. Combine it with `republish: true` to rehearse a republish. Run the Docker-gated end-to-end workflow after a release to build and exercise the new session image.
