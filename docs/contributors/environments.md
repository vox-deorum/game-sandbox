# Adding an Environment

Every environment exposes the [PettingZoo AEC API](https://pettingzoo.farama.org/api/aec/) and registers one `ENTRY` through a Python entry point. Single-agent Gymnasium games use the shared adapter.

Read the [environment specification](../specs/environment.md) for product rules and [Rendering](rendering.md) for browser visuals.

## Checklist

1. Add the environment package and factory.
2. Define a legal default action.
3. Extract a JSON-compatible renderer overlay.
4. Create metadata and `ENTRY`.
5. Register the Python entry point.
6. Pass PettingZoo `api_test` and determinism tests.
7. Sync the self-contained environment code to the student template.
8. Add a template layer and at least one example.
9. Add and register a frontend renderer.

## Directory layout

One directory per environment under `environments/src/game_sandbox_environments/`, each exporting a module-level `ENTRY`:

```text
environments/src/game_sandbox_environments/
  single_agent.py          # the shared Gymnasium -> AEC adapter
  flappy_bird/
    __init__.py            # ENTRY: metadata + factory + hooks (imports the harness)
    env.py                 # the make_env() factory
    overlay.py             # render-data extraction
```

Discovery is automatic after registration.

## Single-agent games: the adapter

A natively single-agent `gymnasium.Env` is lifted into a one-slot AEC environment by `GymnasiumToAEC` in `single_agent.py`. It forwards the seed to the underlying env on reset (the seeding contract every environment must honor) and delegates stepping, observation, and termination bookkeeping. The single slot id is `player_0`: slot ids are PettingZoo agent ids verbatim, in state objects, metadata, and the harness API alike. Your factory just wraps your `gymnasium.make(...)` in this adapter. Multi-agent games subclass `pettingzoo.AECEnv` directly and skip the adapter.

## The factory and the default action

`env.py` exposes `make_env()`, a zero-argument factory that returns a fresh AEC env; the seed arrives at `reset`, not here. It also defines the environment's **default action**: the legal move the loop applies on every timeout path (noop for Flappy Bird, but a real game might return the lowest legal card). Keep `env.py` import-self-contained (relative and third-party imports only): the generate script copies it verbatim into the student template's `sandbox_env/`, so it must not import the harness.

## The overlay

The renderer never sees pixels, so the per-step `overlay` must contain everything the frontend needs to draw the frame. `overlay.py` exposes `extract_overlay(env)`, which returns JSON-compatible, unnormalized display data. For Flappy Bird, this includes the bird's position, velocity, and rotation, along with pipe coordinates, score, and screen dimensions.

Only the environment wrapper may reach into a pinned third-party package's internals. A test must confirm that every overlay field exists and is finite, so an incompatible upstream change fails before it reaches the renderer.

## The registry entry

`__init__.py` ties it together with two frozen dataclasses from `game_sandbox_harness.environment`:

- **`EnvironmentMeta`**: pure, serialisable, public-facing data the backend serves to the frontend. Its `to_json()` output must round-trip through `json.dumps`.
- **`EnvironmentEntry`**: `meta` plus the non-serialisable hooks: `make`, `default_action`, and the optional `overlay`.

This is the only environment module that imports the harness, which is why it is **not** synced into the student template.

### Metadata fields

| Field | Meaning |
| --- | --- |
| `env_id` | Stable id; matches the entry-point name. |
| `display_name`, `description` | Shown on the website. |
| `min_slots`, `max_slots` | Slot-count range. |
| `human_slots` | Tuple of slot ids a human may control. |
| `human_timeout_ms` | Human move clock; `None` when a pace interval governs the deadline. |
| `recommended_episode_ticks` | Suggested episode length. |
| `pace_interval_ms` | Set for realtime (the wall-clock cadence); `None` for turn-based. |
| `step_limit_ms`, `episode_limit_ms` | Default agent time limits (overridable per run). |
| `messaging`, `message_cap` | Whether agents may message, and the length cap. |
| `llm` | Whether the LLM API is available to agents here. |
| `seat_order_matters` | Whether swapping agents between seats makes a distinct game for scheduler rotation. |
| `renderer` | The id the frontend resolves to a renderer module. |

The single session loop reads `pace_interval_ms` rather than branching on an environment type: realtime vs turn-based is this one field, not a second code path.

## Registration

Register the entry in `environments/pyproject.toml` under the `game_sandbox.environments` group, name = env id:

```toml
[project.entry-points."game_sandbox.environments"]
flappy_bird = "game_sandbox_environments.flappy_bird:ENTRY"
```

The harness enumerates installed environments through `importlib.metadata` and never imports this package, keeping the dependency arrow pointing one way (environments → harness).

## PettingZoo conformance

Every environment must pass PettingZoo's own conformance check, so correctness is verified by the framework rather than our assumptions:

```python
from pettingzoo.test import api_test
api_test(make_env(), num_cycles=100)
```

Pair it with an environment-level determinism test (two resets with the same seed produce identical observation and overlay sequences) and the overlay-field test described above.

## Syncing to the template

Students run the environment locally without the harness. `scripts/generate.py` copies the self-contained modules into `templates/<env>/sandbox_env/`.

Register the environment and module list in `scripts/_paths.py` under `TEMPLATE_ENVS`, add the generated `__init__` text in `scripts/generate.py`, then regenerate:

```console
uv run python scripts/generate.py
```

The template's top-level `sandbox_env` package exposes `make_env`, `ENV_ID`, and `PLAYER_SLOT`. Never sync harness, recording, or metadata modules. See [Examples and the template](examples-and-template.md).
