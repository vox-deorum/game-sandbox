# Stage 2: The Environments Package and Public Metadata

Part of [Stage 2](../stage-02-harness-and-first-environment.md). This file designs the `environments/` package, the in-house compatibility wrapper that gives single-agent games a PettingZoo shape per [environment.md](../../docs/specs/environment.md), the Flappy Bird environment itself, and the public-facing metadata layer.

## Package layout

`environments/` becomes the third uv workspace member, distribution package name `game-sandbox-environments`. Each environment is its own top-level import package under `environments/src/`, named by its env id, for example `flappy_bird`. The distribution depends on `game-sandbox-harness` (for the metadata types below), `pettingzoo`, and `gymnasium`.

```
environments/
  pyproject.toml
  src/
    flappy_bird/
      __init__.py            ENTRY: the registry entry (metadata + factory + hooks)
      env.py                 factory for the local Flappy Bird simulation
      overlay.py             render-data extraction
      single_agent.py        GymnasiumToAEC adapter
  tests/
```

One top-level package per environment, each exporting a module-level `ENTRY`. The wheel build lists each package explicitly in `environments/pyproject.toml`, so adding Hearts in Stage 7 means adding `src/hearts/`, registering its entry point, and adding it to the wheel package list.

## The adapter

`GymnasiumToAEC` subclasses `pettingzoo.AECEnv` and wraps any `gymnasium.Env` as a one-slot AEC environment. It is in-house and small by design. No off-the-shelf converter exists in this direction: Shimmy adapts external suites _to_ Gymnasium/PettingZoo, and PettingZoo's own conversions are AEC↔Parallel. The adapter is only about 100 lines. Each single-agent environment keeps a copy beside its `env.py`, so its local imports stay self-contained and the template sync can copy the same package-shaped modules students run locally.

The single agent id is `player_0`, following the PettingZoo naming convention. This settles the slot id question Stage 1 deferred: **slot ids are PettingZoo agent ids, verbatim**, in state objects, metadata, and the harness API alike.

`reset(seed=...)` forwards the seed to the underlying `gymnasium.Env.reset`, the seeding contract [environment.md](../../docs/specs/environment.md) requires. Forwarding the seed is what makes the wrapped game's own RNG fully determined by the seed: for Flappy Bird, the NumPy generator that places the pipes. So two resets with the same seed produce identical observation and overlay sequences.

This is the foundation the harness-level "same seed twice produces identical recordings" exit criterion stands on. The recording is written through `_dump_line`'s `sort_keys`, so key order is not a variable, and every timestamp comes from an injected `ManualClock` (see [session-harness.md](session-harness.md)). That leaves the environment itself as the only remaining source of nondeterminism, and full seed forwarding removes it. The environment-level determinism test in [testing-ci-and-docs.md](testing-ci-and-docs.md) asserts exactly this, ahead of the recording-level test, so a seeding gap is caught at the wrapper rather than misattributed to the harness.

`step`, `observe`, `last`, the space accessors, and termination/truncation bookkeeping are straight delegation. The adapter is validated with PettingZoo's own `pettingzoo.test.api_test`, so conformance is checked by the framework rather than by our assumptions.

## Flappy Bird

Flappy Bird uses the local pygame-free adaptation of the non-rendering `flappy-bird-gymnasium` 0.4.0 simulation. Its public immutable snapshot supplies observations and overlays, so no third-party private fields are read. Action space is `Discrete(2)`: 0 is noop, 1 is flap. The default action for every timeout path is 0. The per-step `score` follows the preserved reward scheme: +0.1 per frame alive, +1.0 per pipe, −1.0 on death, and −0.5 for hitting the ceiling.

The renderer never sees pixels, so the overlay must carry everything Stage 4 needs to draw the frame:

- player `x`/`y`, velocity, and rotation;
- the pipe list as unnormalized screen coordinates (`x`, `gap_top`, `gap_bottom` per pipe);
- the pipes-passed count;
- the logical screen `width`/`height`.

The dimensions are emitted on every step rather than only the first, so each frame is self-describing for the renderer at a cost of a few bytes. The normalized observation vector is not enough to reconstruct a frame, so `overlay.py` reads the wrapped environment's internal game state. Reaching into a third-party package's internals is acceptable only here: inside the environment's own wrapper, against a pinned version, and covered by a test that asserts every overlay field exists and is finite. If an upgrade ever breaks it, that test fails before the renderer does. Should the internals prove too opaque at implementation time, the documented escalation is to vendor a minimal Flappy Bird implementation into `flappy_bird/`, since the spec only asks for a "Flappy Bird style" game. The display `observation` field in per-step states is omitted for Flappy Bird, because the overlay carries strictly more and lines stay small.

## Metadata and the registry entry

The types live in the harness package (`game_sandbox_harness.environment`), because the harness loop and the Stage 3 container consume them and the environments package already depends on the harness; the reverse import would be a cycle. Two frozen dataclasses:

`EnvironmentMeta` is the serializable public-facing layer, field-for-field what [environment.md](../../docs/specs/environment.md) lists: `env_id`, `display_name`, `description`, `min_slots`, `max_slots`, `human_slots` (tuple of slot ids), `human_timeout_ms` (None when the pace interval governs, see below), `recommended_episode_ticks`, `pace_interval_ms` (None for turn-based), an optional `view_interval_ms` (a watch/replay playback cadence independent of the stepping model, so a turn-based game can be watched at a paced speed without becoming realtime), an optional `live_interval_ms` (a live human-session cadence that spaces out other seats' streamed moves without changing environment stepping or scoring), `step_limit_ms`, `episode_limit_ms`, `messaging` plus `message_cap`, `llm`, `seat_order_matters` for multi-seat scheduler rotation, and `renderer` (a string id the frontend resolves in Stage 4). A `to_json()` method emits the snake_case dict the backend will serve verbatim; a test round-trips it through `json.dumps`.

`EnvironmentEntry` is the full registration: `meta`, `make()` (a zero-argument factory returning a fresh AEC env; the seed arrives at reset), `default_action(slot_id)` (the environment-provided legal default the loop applies on every timeout path), and an optional `overlay(env)` hook returning the per-step overlay dict. The non-serializable hooks live here, outside `EnvironmentMeta`, which stays pure data.

Discovery uses Python entry points: group `game_sandbox.environments`, name = env id, value = `flappy_bird:ENTRY`. The harness CLI and the Stage 3 container enumerate installed environments through `importlib.metadata`. The harness never imports an environment package by name, which keeps the dependency arrow pointing one way.

Proposed Flappy Bird values, to confirm when the stage starts: one slot (`min_slots = max_slots = 1`), `human_slots = ("player_0",)`, `pace_interval_ms = 50` (20 steps per second: flagged for tuning during Stage 4 playtesting), `human_timeout_ms = None` per the [interaction.md](../../docs/specs/interaction.md) rule that a set pace interval is itself the human deadline, `recommended_episode_ticks = 1000`, `step_limit_ms = 1000`, `episode_limit_ms = 120_000`, `messaging = False`, `llm = False`, `renderer = "flappy-bird"`.
