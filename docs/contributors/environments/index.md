# Adding an Environment

An environment is the package, browser renderer, student template layer, examples, and documentation that let people play one game in Game Sandbox.

Read the [environment specification](../../specs/environment.md) for product rules, then use the focused guides below while you build the environment.

| Task | Guide |
| --- | --- |
| Build, register, and test the Python package | [Environment package](package.md) |
| Build the shared live and replay renderer | [Rendering](rendering.md) |
| Create the student kit, examples, and student page | [Template and examples](template-and-examples.md) |
| Version and publish the student product | [Template product and releases](../template.md) |

## Checklist

1. Create `environments/<env>/` with the factory, legal default action, overlay extractor, metadata, and `ENTRY`.
2. Add game-rule tests under `environments/<env>/tests/` and renderer tests under `environments/<env>/renderer/`.
3. Add the hand-authored `template/` layer and at least one `examples/<name>/` directory beside the environment package.
4. Add a student helper module and its pin test when raw observations or actions need decoding.
5. Write the student environment page and add a row to the [student environments index](../../students/environments/index.md).
6. Run `npm run sync:envs`, compose the template, run the repository checks, and play-test the environment.
7. Publish the environment's template and example branches by riding the next version bump or by dispatching the [Publish Template workflow](../template.md) with the current N and `republish: true`.

A new environment is not complete when it merely runs. A student must be able to learn, run, and improve an agent without reading the environment source.

## Directory layout

Each environment is one top-level package under `environments/`, importable by its env id and exporting a module-level `ENTRY`.

```text
environments/
  flappy_bird/
    __init__.py            # ENTRY: metadata + factory + hooks
    env.py                 # make_env() and default_action()
    overlay.py             # render-data extraction
    single_agent.py        # Gymnasium to AEC adapter when needed
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

The environment directories are the registration source. `npm run sync:envs` discovers environment packages and regenerates registration, wheel packaging, and backend metadata. The shared platform conformance test is `environments/test_conformance.py`, and shared renderer infrastructure remains in `frontend/src/renderers/`.

## Play test

`npm run play -- <env> [mode]` rebuilds the local frontend, then starts loopback browser play with the production live runner and the same PixiJS renderer used by a live session.

It needs no backend, Docker, or external network connection. `mode` is `human` by default, `agent` to watch the bundled example agent, or `watch` to use the built-in baseline.

Every mode starts paused at the first frame. Use Start when ready, then use the shared pause, resume, and stop controls. Pass `--seat` for a multi-slot seat or `--agent-repo <path>` for an agent repository with a `manifest.json`.
