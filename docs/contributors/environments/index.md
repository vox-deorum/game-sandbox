# Adding an Environment

An environment contains everything needed to play one game in Game Sandbox: a Python package, browser renderer, student template layer, examples, and documentation.

Read the [environment specification](../../specs/environment.md) for product rules, then use the focused guides below while you build the environment.

| Task | Guide |
| --- | --- |
| Build, register, and test the Python package | [Environment package](package.md) |
| Build the shared live and replay renderer | [Rendering](rendering.md) |
| Create the student kit, examples, and student page | [Template and examples](template-and-examples.md) |
| Version and publish the student product | [Template product and releases](templates.md) |

## Checklist

1. Create `environments/<env>/` with the factory, legal default action, overlay extractor, metadata, and `ENTRY`.
2. Add game-rule tests under `environments/<env>/tests/` and renderer tests under `environments/<env>/renderer/`.
3. Add the hand-authored `template/` layer and at least one `examples/<name>/` directory beside the environment package.
4. Add a student helper module and its pin test when raw observations or actions need decoding.
5. Write the canonical `environments/<env>/environment.md` guide. MkDocs discovers the guide as a virtual page and adds it to the student environment catalog, so do not add a manual catalog entry, mirror, or navigation item for the environment.
6. Run `npm run sync:envs`, compose the template, run the repository checks, and play-test the environment.
7. Publish the environment's template and example branches with the next version bump, or dispatch the [Publish Template workflow](templates.md) with the current `N` and `republish: true`.

A new environment must let a student learn, run, and improve an agent without reading its source.

## Directory layout

Each environment is a top-level package under `environments/`. It must be importable by its environment id and export a module-level `ENTRY`.

```text
environments/
  flappy_bird/
    __init__.py            # ENTRY: metadata + factory + hooks
    env.py                 # make_env() and default_action()
    overlay.py             # render-data extraction
    single_agent.py        # Gymnasium to AEC adapter when needed
    environment.md         # canonical student guide
    renderer/              # browser renderer and its tests
    tests/                 # environment-specific rule tests
    template/              # hand-authored student layer, not a Python package
      agent.py
      README.md
      sandbox/features.py
      tests/
    examples/              # hand-authored worked-agent overlays
      hello/
```

`templates/base/` remains the environment-agnostic student layer. Compose generates the environment package, harness, and shared helpers into `build/`, then overlays the hand-authored environment template and, when requested, an example.

The environment directories are the source of registration data. `npm run sync:envs` discovers the packages and regenerates their registration, wheel packaging, and backend metadata. The shared platform conformance test is `environments/test_conformance.py`. Shared renderer infrastructure lives in `frontend/src/renderers/`.

## Play test

`npm run play -- <env> [mode]` rebuilds the local frontend and starts loopback play with the production live runner and renderer.

It needs no backend, Docker, or external network connection. `mode` is `human` by default, `agent` to watch the repository selected by `--agent-repo`, or `watch` to use the built-in baseline.

Every mode starts paused at the first frame. Use Start when ready, then use the shared pause, resume, and stop controls. The flags:

- `--parameter name=value`, once per gameplay parameter override.
- `--seat` selects a seat from the resolved layout.
- `--companion naive` or `--companion <manifest-path>` supplies the independently constructed agents for a human seat that covers more than one player.
- `--agent-repo <path>` selects the agent repository (with a `manifest.json`) that agent mode runs.
