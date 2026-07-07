# Stage 11.4: Flappy Bird Semantic Observation

Status: not started.

Part of [Stage 11](../stage-11-semantic-contract.md). This is build-order step 4, the last environment conversion. Flappy Bird's observation today is an opaque twelve-float vector; its overlay already speaks the object language (a player object and a pipe list in screen pixels). This step gives the agent the same view the renderer gets, so the platform's one realtime environment carries an object-shaped observation like the card games. The action stays `Discrete(2)` (0 = idle, 1 = flap) — already the simplest possible PettingZoo action, and unchanged.

## Why this is its own seam

The card games convert by re-encoding state they already own; Flappy Bird converts by changing where its observation comes from. The wrapped Gymnasium game produces the normalized feature vector, so the object-shaped observation must be read from the game's internals instead — the same source the overlay extractor already reads. That is a different kind of change from steps 2 and 3, it touches the single-agent adapter path, and it completes the invariant that every registered environment carries an object-shaped observation and a real composite observation space.

## What to build

### Environment

`environments/src/flappy_bird/single_agent.py` keeps `GymnasiumToAEC` exactly as it is; it remains a generic adapter for any Gymnasium game, and its `observation_space`/`action_space` accessors already return real per-agent spaces — today, the wrapped game's normalized twelve-float `Box`. The flappy-specific behavior lands in a new `FlappyBirdEnv(GymnasiumToAEC)` subclass in `environments/src/flappy_bird/env.py`, which today is a factory whose `make_env()` returns `GymnasiumToAEC(...)` directly; that factory is rewired to instantiate the subclass. The subclass **overrides the two space accessors** so `observation_space` returns the object-shaped Dict below (in place of the inherited float vector) and `action_space` returns `spaces.Discrete(2)`. `observe()` builds the observation dict from the wrapped game's internals; `step()` keeps taking the integer `Discrete(2)` input (0 idle, 1 flap) and passes it straight to the wrapped game. `NOOP_ACTION` is replaced by the module-level `default_action(env, slot_id)` returning `0` (idle).

`environments/src/flappy_bird/overlay.py` is refactored to expose `read_player_and_pipes(game)`, and both `extract_overlay` and `FlappyBirdEnv.observe` call it, so the observation and the overlay come from one reading of the same internals, in the same pixel coordinate system (y grows downward). Values pass through `float()` and `int()` coercions so NumPy scalars never enter the observation.

### Observation space

```python
observation_space = spaces.Dict({
    "player": spaces.Dict({k: spaces.Box(-np.inf, np.inf, shape=(), dtype=np.float32)
                           for k in ("x", "y", "vel_y", "rot")}),
    "pipes": spaces.Sequence(spaces.Dict({k: spaces.Box(-np.inf, np.inf, shape=(), dtype=np.float32)
                                          for k in ("x", "gap_top", "gap_bottom")})),   # nearest first
    "pipes_passed": spaces.Box(0, np.iinfo(np.int64).max, shape=(), dtype=np.int64),
    "width": spaces.Discrete(4096), "height": spaces.Discrete(4096)})
action_space = spaces.Discrete(2)   # 0 = idle, 1 = flap
```

`pipes` is ordered nearest first and replaces the fixed last, next, and next-next pipe triple the normalized vector encoded; helpers in the template layer recover "the next pipe" from it. `width` and `height` state the screen so positions are interpretable without out-of-band knowledge. There is no `action_mask` — both actions are always legal while the bird is alive, and `Discrete(2)` samples cleanly for `api_test`. `flappy_bird/human.py` keeps mapping the tap input to the integer `1`.

## Tests

`environments/tests/test_flappy_bird.py` is updated where it asserted on the vector:

- **`test_passes_pettingzoo_api_test` stays** and passes over the object-shaped observation, dead-step cycle included.
- Every observation across a full seeded episode satisfies `observation_space.contains(obs)`, round-trips unchanged through JSON, and contains only plain floats and ints, never NumPy scalars.
- Pipes are ordered nearest first, and the observation agrees with the overlay on player position and pipe geometry for the same tick, pinning the shared `read_player_and_pipes` source.
- `step` still takes the integer `Discrete(2)` input; `default_action` returns `0`.
- No test asserts exact decimal renderings of positions; assertions compare numerically.

## Done when

A Flappy Bird episode plays to completion through the harness at the same 50 ms cadence as before, over the object-shaped observation, and the local pygame window plays it with the tap mapped to flap. All three registered environments now carry object-shaped observations and real composite observation spaces, `test_passes_pettingzoo_api_test` passes for each, and the Python suite is green.
