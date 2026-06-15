# Stage 2: The Environments Package and Public Metadata

Part of [Stage 2](../stage-02-harness-and-first-environment.md). This file designs the `environments/` package, the in-house compatibility wrapper that gives single-agent games a PettingZoo shape per [environment.md](../../docs/specs/environment.md), the Flappy Bird environment itself, and the public-facing metadata layer.

## Package layout

`environments/` becomes the third uv workspace member, package name `game-sandbox-environments`, importable as `game_sandbox_environments`. It depends on `game-sandbox-harness` (for the metadata types below) plus `pettingzoo`, `gymnasium`, and `flappy-bird-gymnasium`.

```
environments/
  pyproject.toml
  src/game_sandbox_environments/
    __init__.py
    single_agent.py          GymnasiumToAEC adapter
    flappy_bird/
      __init__.py            ENTRY: the registry entry (metadata + factory + hooks)
      env.py                 factory wrapping flappy-bird-gymnasium
      overlay.py             render-data extraction
  tests/
```

One directory per environment, each exporting a module-level `ENTRY`. Hearts adds a sibling directory in Stage 7 and touches nothing else.

## The adapter

`GymnasiumToAEC` subclasses `pettingzoo.AECEnv` and wraps any `gymnasium.Env` as a one-slot AEC environment. It is in-house and general-purpose by design: no off-the-shelf converter exists in this direction (Shimmy adapts external suites _to_ Gymnasium/PettingZoo, and PettingZoo's own conversions are AEC↔Parallel), the adapter is ~100 lines, and owning it means any future single-agent game — classic Atari included — comes in with zero new machinery. The single agent id is `player_0`, following the PettingZoo naming convention; this settles the slot id question Stage 1 deferred — **slot ids are PettingZoo agent ids, verbatim**, in state objects, metadata, and the harness API alike. `reset(seed=...)` forwards the seed to the underlying `gymnasium.Env.reset`, which is the seeding contract [environment.md](../../docs/specs/environment.md) requires. Forwarding the seed is what makes the wrapped game's own RNG — for Flappy Bird, the NumPy generator that places the pipes — fully determined by the seed, so two resets with the same seed produce identical observation and overlay sequences. This is the foundation the harness-level "same seed twice produces identical recordings" exit criterion stands on: with the recording written through `_dump_line`'s `sort_keys` (key order is not a variable) and every timestamp coming from an injected `ManualClock` (see [session-harness.md](session-harness.md)), the only remaining source of nondeterminism is the environment itself, and full seed forwarding removes it. The environment-level determinism test in [testing-ci-and-docs.md](testing-ci-and-docs.md) asserts exactly this, ahead of the recording-level test, so a seeding gap is caught at the wrapper rather than misattributed to the harness. `step`, `observe`, `last`, the space accessors, and termination/truncation bookkeeping are straight delegation. The adapter is validated with PettingZoo's own `pettingzoo.test.api_test`, so conformance is checked by the framework rather than by our assumptions.

## Flappy Bird

The game comes from `flappy-bird-gymnasium` (v0.4.0, the current release), pinned exactly — both because the dependency set pins everything and because the overlay extraction below reads the package's internals, which only a pinned version makes safe. The factory creates `FlappyBird-v0` with the 12-feature numerical observation (`use_lidar=False`); the agent sees those features, exactly what it will see locally against the template. Action space is `Discrete(2)`: 0 is noop, 1 is flap. The default action for every timeout path is 0. The per-step `score` is the cumulative reward under the package's scheme (+0.1 per frame alive, +1.0 per pipe, −1.0 on death, −0.5 for hitting the ceiling).

The renderer never sees pixels, so the overlay must carry everything Stage 4 needs to draw the frame: player `x`/`y`, velocity and rotation, the pipe list as unnormalized screen coordinates (`x`, `gap_top`, `gap_bottom` per pipe), the pipes-passed count, and the logical screen `width`/`height`. (Implementation note: the dimensions are emitted on every step rather than only the first, so each frame is self-describing for the renderer at a cost of a few bytes.) The normalized observation vector is not enough to reconstruct a frame, so `overlay.py` reads the wrapped environment's internal game state. Reaching into a third-party package's internals is acceptable only here, inside the environment's own wrapper, against a pinned version, and covered by a test that asserts every overlay field exists and is finite — if an upgrade ever breaks it, the test fails before the renderer does. If the internals prove too opaque at implementation time, the documented escalation is to vendor a minimal Flappy Bird implementation into `flappy_bird/`; the spec only asks for a "Flappy Bird style" game. The display `observation` field in per-step states is omitted for Flappy Bird: the overlay carries strictly more, and lines stay small.

## Metadata and the registry entry

The types live in the harness package (`game_sandbox_harness.environment`), because the harness loop and the Stage 3 container consume them and the environments package already depends on the harness; the reverse import would be a cycle. Two frozen dataclasses:

`EnvironmentMeta` is the serializable public-facing layer, field-for-field what [environment.md](../../docs/specs/environment.md) lists: `env_id`, `display_name`, `description`, `min_slots`, `max_slots`, `human_slots` (tuple of slot ids), `human_timeout_ms` (None when the pace interval governs, see below), `recommended_episode_ticks`, `pace_interval_ms` (None for turn-based), `step_limit_ms`, `episode_limit_ms`, `messaging` plus `message_cap`, `llm`, and `renderer` (a string id the frontend resolves in Stage 4). A `to_json()` method emits the snake_case dict the backend will serve verbatim; a test round-trips it through `json.dumps`.

`EnvironmentEntry` is the full registration: `meta`, `make()` (a zero-argument factory returning a fresh AEC env; the seed arrives at reset), `default_action(slot_id)` (the environment-provided legal default the loop applies on every timeout path), and an optional `overlay(env)` hook returning the per-step overlay dict. The non-serializable hooks live here, outside `EnvironmentMeta`, which stays pure data.

Discovery uses Python entry points, group `game_sandbox.environments`, name = env id, value = `game_sandbox_environments.flappy_bird:ENTRY`. The harness CLI and the Stage 3 container enumerate installed environments through `importlib.metadata` without the harness ever importing the environments package, keeping the dependency arrow pointing one way.

Proposed Flappy Bird values, to confirm when the stage starts: one slot (`min_slots = max_slots = 1`), `human_slots = ("player_0",)`, `pace_interval_ms = 50` (20 steps per second — flagged for tuning during Stage 4 playtesting), `human_timeout_ms = None` per the [interaction.md](../../docs/specs/interaction.md) rule that a set pace interval is itself the human deadline, `recommended_episode_ticks = 1000`, `step_limit_ms = 1000`, `episode_limit_ms = 120_000`, `messaging = False`, `llm = False`, `renderer = "flappy-bird"`.
