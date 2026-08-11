# Template Product and Releases

The composed template combines shared files with one environment's hand-authored layer and, optionally, a worked example.

```text
templates/base
      +
environments/<env>/template
      +
environments/<env>/examples/<name>   (optional)
      ->
complete runnable repository
```

Read [Environment template and examples](template-and-examples.md) to create an environment layer. This page covers the composed template, its version, and publication.

## Composition

`uv run python scripts/compose.py <env>` copies `templates/base/` into `build/templates/<env>/`, generates the environment package, harness, and shared helpers into that output, copies every declared builtin from the matching frozen `deps-v<N>` tree into `sandbox/builtins/`, and copies the environment's `template/` directory onto it.

Composition is intentionally disposable. Recompose every template and example after changing environment metadata, gameplay parameter declarations, the harness launch contract (the launch configuration and stdio protocol the backend shares with the session container), or the generated factory signature. Outputs composed from another checkout are unsupported.

`uv run python scripts/compose.py <env> <name>` also layers `environments/<env>/examples/<name>/` onto `build/examples/<env>/<name>/`.

Composition replaces whole files. The only merged file is `requirements.extra.txt`: it appends pins but cannot override a pin already in `requirements.txt`.

The [`PUBLISHED_EXAMPLES` allowlist](template-and-examples.md#hand-authored-layers) selects which examples the publish step turns into public branches.

Compose copies the canonical `environments/<env>/environment.md` guide into each composed template as `environment.md`, alongside the shared LLM guide as `llm.md`. It rewrites `{{DOCS_URL}}` and fails if a required guide or token is missing. The local browser bundle is added only to a release or dry-run staging tree.

## Versioned dependency set

A student's repository, the CI checks, and the session container that runs the agent must all use identical dependencies, so one version number, `N`, ties together the `template-v<N>` tag, the `deps-v<N>` session image, and each agent manifest's `template_version`.

`templates/base/manifest.json` is the canonical template value. `scripts/bump_template_version.py` updates every coupled touchpoint, and CI runs it with `--check` to catch drift.

The backend's `TEMPLATE_REPO_URL` setting must name the same repository as `DEFAULT_TARGET_REPO` in `scripts/publish_template.py`. My Submissions uses that setting and the branches created by the publisher when a season does not provide its own repository URL.

Edit `templates/base/requirements.in` to change dependencies, then regenerate `templates/base/requirements.txt` with `uv pip compile`. Do not hand-edit the pinned file.

An active, unreleased `deps-v<N>` directory may be regenerated with its matching template. Once published, the matching `deps-v<N>` directory is immutable. A [republish](#cutting-a-release) reuses it because CI pins every dependency reference to it.

## Cutting a release

The release owner needs workflow and write permissions. Contributors should run `uv run python scripts/ci.py publish-dry-run` before asking for publication.

A typical release dispatches the Publish Template workflow from `main` with the next `N`. A few special cases use the same workflow with different inputs:

| Dispatch input | Behavior |
| --- | --- |
| Greater `N` | Creates the next frozen `deps-v<N>` dependency set and updates the owned version touchpoints. |
| Same `N` | Retries a release whose `template-v<N>` tag never landed. |
| Same `N`, `republish: true` | Refreshes an already-tagged release from the current `main`, force-pushing the student repository. Use it to publish an environment merged after `template-v<N>` shipped. |
| Lower `N` | Refused. |

The workflow verifies the selected commit, builds the local frontend once, and uses the same composition path as local checks. It publishes the default template to the student repository's `main` branch, environment templates to `templates/<env>`, and selected examples to `examples/<env>/<name>`. After pushing every desired branch, a real publish removes generated `examples/*` branches that are no longer in `PUBLISHED_EXAMPLES`. It leaves all other branches unaffected.

The two release forms differ only in their final steps:

| Final step                            | Normal release | Republish |
| ------------------------------------- | -------------- | --------- |
| Fast-forward this repository's `main` | Yes            | No        |
| Write the `template-v<N>` tag         | Yes            | No        |

Use `dry_run: true` to rehearse the full path without contacting or mutating the student repository, `main`, or tags. Combine it with `republish: true` to rehearse a republish. Run the Docker-gated end-to-end workflow after a release to build and exercise the new session image.

A republish keeps the existing template version.
