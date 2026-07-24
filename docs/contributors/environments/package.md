# Environment Package

An environment package defines the PettingZoo behavior and the public metadata that the backend and browser consume.

Read the [environment specification](../../specs/environment.md) before changing this contract.

## Package shape

`env.py` exposes `make_env(parameters)`, a factory that receives the complete resolved gameplay parameter map and returns a fresh PettingZoo agent-environment-cycle (AEC) environment. The map always contains the synthesized `seats` value. The seed is passed to `reset`, not to the factory.

It also defines `default_action(env, slot_id)`, which returns the legal integer applied when a slot has no action. For example, Flappy Bird returns idle, Hearts returns the lowest legal card, and Spades returns a never-nil bid or the lowest legal card.

Every module copied into the composed `sandbox.env` package must be self-contained for imports. It may use relative and third-party imports, but only `__init__.py` may import the harness.

### Single-agent games

`GymnasiumToAEC` in `single_agent.py` adapts a native `gymnasium.Env` into a one-slot AEC environment. It forwards the reset seed and handles stepping, observations, and termination bookkeeping through the wrapped environment.

The single slot id is `player_0`. Slot ids are PettingZoo agent ids verbatim in state objects, metadata, and harness APIs.

Multi-agent games subclass `pettingzoo.AECEnv` directly and do not use the adapter.

### Overlay

`overlay.py` exposes `extract_overlay(env)`, returning JSON-compatible display data. The browser renderer never inspects the live environment, so the overlay contains everything needed to draw a frame.

The environment owns its display state. Test that every overlay field exists and is finite.

### Registry entry and metadata

`__init__.py` exports an `EnvironmentEntry` made from `EnvironmentMeta`, the environment factory, `default_action`, and the optional overlay hook.

`EnvironmentMeta.to_json()` must round-trip through `json.dumps` because the backend serves it to the frontend.

| Field | Meaning |
| --- | --- |
| `env_id` | Stable id and entry-point name. |
| `display_name`, `description` | Public website text. |
| `min_slots`, `max_slots`, `human_slots` | Supported seats and human-capable slots. |
| `parameters` | Typed gameplay parameter declarations. The public JSON also includes synthesized `seats`. |
| `human_timeout_ms` | Human move clock, or `None` when pacing is the deadline. |
| `recommended_episode_ticks` | Suggested episode length. |
| `pace_interval_ms` | Realtime cadence, or `None` for turn-based play. |
| `view_interval_ms`, `live_interval_ms` | Optional replay and live viewing cadence. They never affect scoring. |
| `step_limit_ms`, `episode_limit_ms` | Default agent compute limits. |
| `messaging`, `message_cap`, `llm` | Optional agent capabilities. |
| `seat_order_matters` | Whether scheduler seat order creates a distinct game. |
| `renderer` | Browser renderer id. |

The session loop reads `pace_interval_ms` instead of branching on the game type.

Declare gameplay parameters with the frozen `EnvParameter` and `EnvParameterChoice` dataclasses from `game_sandbox_harness.environment`. Names use snake_case, must be unique, and cannot be `seats`. Numeric parameters declare inclusive bounds. Choice values are stable non-empty strings with separate friendly labels.

The factory must use the values it owns. For example, Flappy Bird passes `int(parameters["pipe_gap"])` to its game constructor. A future variable-seat environment reads `parameters["seats"]` when it creates `possible_agents`. The harness validates and normalizes the map before calling the factory and then verifies that the resulting agent count matches `seats`.

Use `effective_parameters(meta)` when a consumer needs declarations including `seats`, and use `resolve_parameters(meta, overrides)` before constructing an environment outside the session harness. Do not build a partial map by hand.

## Registration and distribution

Do not edit the entry-point table or wheel package list by hand. `npm run sync:envs` discovers packages under `environments/`, reads `ENTRY`, and regenerates `environments/pyproject.toml` and backend metadata.

`environments/.envignore` lists Python packages that are not environments. For example, `local_play/` contains shared helpers and is excluded from registration.

The wheel excludes `*/renderer`, `*/tests`, `*/template`, and `*/examples`, so browser code and student authoring layers stay in the repository without shipping in the environment wheel.

## Conformance

Every environment runs PettingZoo conformance through the shared guard in `environments/test_conformance.py`.

```python
from pettingzoo.test import api_test

parameters = resolve_parameters(ENTRY.meta)
api_test(make_env(parameters), num_cycles=100)
```

The pinned PettingZoo version has a known `api_test` issue with object-shaped composite observations. The shared guard accepts only that exact failure as expected. Direct `observation_space.contains()` checks still cover a full episode.

The discovery-driven suite also checks determinism, overlay JSON and finite values, and the required colocated template and example shape. Keep game-specific rules and regressions in `environments/<env>/tests/`.
