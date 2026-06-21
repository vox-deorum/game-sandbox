# Adding an Environment

Every environment in Game Sandbox exposes a PettingZoo AEC interface and registers a single `ENTRY` discovered by the harness through a Python entry point. Single-agent games come in through the in-house compatibility wrapper, so they fit the same shape as multi-agent games. This page is the how-to; the design rationale lives in the [environment spec](../specs/environment.md). Flappy Bird is the worked example throughout, and Hearts (Stage 7) will be the first to follow this path from scratch.

## Directory layout

One directory per environment under `environments/src/game_sandbox_environments/`, each exporting a module-level `ENTRY`:

```
environments/src/game_sandbox_environments/
  single_agent.py          # the shared Gymnasium -> AEC adapter
  flappy_bird/
    __init__.py            # ENTRY: metadata + factory + hooks (imports the harness)
    env.py                 # the make_env() factory
    overlay.py             # render-data extraction
```

Adding an environment means adding a sibling directory and touching nothing else: discovery is automatic.

## Single-agent games: the adapter

A natively single-agent `gymnasium.Env` is lifted into a one-slot AEC environment by `GymnasiumToAEC` in `single_agent.py`. It forwards the seed to the underlying env on reset (the seeding contract every environment must honor) and delegates stepping, observation, and termination bookkeeping. The single slot id is `player_0`: slot ids are PettingZoo agent ids verbatim, in state objects, metadata, and the harness API alike. Your factory just wraps your `gymnasium.make(...)` in this adapter. Multi-agent games subclass `pettingzoo.AECEnv` directly and skip the adapter.

## The factory and the default action

`env.py` exposes `make_env()`, a zero-argument factory that returns a fresh AEC env; the seed arrives at `reset`, not here. It also defines the environment's **default action**: the legal move the loop applies on every timeout path (noop for Flappy Bird, but a real game might return the lowest legal card). Keep `env.py` import-self-contained (relative and third-party imports only): the generate script copies it verbatim into the student template's `sandbox_env/`, so it must not import the harness.

## The overlay

The renderer never sees pixels, so the per-step `overlay` must carry everything the frontend needs to draw the frame. `overlay.py` exposes `extract_overlay(env)` returning a JSON-able dict of unnormalized display data (for Flappy Bird: the bird's position/velocity/rotation, the pipe coordinates, the score, and the screen dimensions). Reaching into a third-party package's internals is acceptable only here, inside the environment's own wrapper, against a pinned version, and **must** be covered by a test asserting every overlay field exists and is finite: so an upstream upgrade that breaks the internals fails the test before it breaks the renderer.

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

## The api_test requirement

Every environment must pass PettingZoo's own conformance check, so correctness is verified by the framework rather than our assumptions:

```python
from pettingzoo.test import api_test
api_test(make_env(), num_cycles=100)
```

Pair it with an environment-level determinism test (two resets with the same seed produce identical observation and overlay sequences) and the overlay-field test described above.

## Syncing to the template

Students run your environment locally against vanilla PettingZoo, so the import-self-contained modules (`single_agent.py`, `env.py`, `overlay.py`) are copied into that environment's template layer at `templates/<env>/sandbox_env/` by `scripts/generate.py`, and the staleness CI job keeps the copy current. Only the steppable environment is synced: never the harness, recording store, or metadata layer. Register the env id and its synced module list in `scripts/_paths.py` `TEMPLATE_ENVS`, give it generated `__init__` texts in `scripts/generate.py` (the top-level `sandbox_env/__init__.py` exposes the uniform `make_env`/`ENV_ID`/`PLAYER_SLOT` surface the env-agnostic template scripts read), then run `uv run python scripts/generate.py` after changing any synced module. The full template-layer checklist lives in [Examples and the template](examples-and-template.md).
