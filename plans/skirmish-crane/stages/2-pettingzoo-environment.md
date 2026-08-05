# Step 2: PettingZoo Environment, Metadata, and Naive

Status: complete.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 2: the platform-facing environment on the step 1 engine, exactly as [environment.md](../environment.md) specifies it, plus the naive agent's code. The package stays unregistered behind `environments/.envignore`. The hands-on surface is full recorded episodes through the harness.

## Why this is its own seam

This step is the platform's first production consumer of composite action spaces, and it declares every space, parameter, and metadata value the rest of the build relies on. Landing it before the renderer means the contract is complete and conformance-tested when registration (step 3) makes it public, and nothing about spaces or metadata churns afterward.

## What to build

`env.py` (the AEC environment and `make_env(parameters)`), `overlay.py` (`extract_overlay(env)`), and `__init__.py` with `META`, `ENTRY`, and `PUBLISHED_EXAMPLES = ()`, following the spades package shape. The naive agent's code and tests land here; its staging under `backend/images/session-base/deps-v1/builtin/skirmish_crane/naive/` lands with registration in step 3.

### Reconciling with the step 1 engine

Two gaps between the engine and [environment.md](../environment.md) are this step's to close, not the engine's:

- Parameter bounds. The spec declares `capture_target` from 10 to 10000 and `round_cap` from 100 to 10000. The engine only requires each to be positive, because bounding a season parameter belongs to the parameter schema rather than to the rules. This step's schema enforces the declared ranges.
- Observation shape. The engine's internal perception is not the declared observation. Its `capture` value carries the two side scores without the target, and its battlefield snapshot also carries `extent`, `spawns`, and `passage_tiles`. This step reshapes perception into the spec's table rather than passing it through, and the engine's snapshot is free to keep whatever the rules find useful.

The engine hands out `tiles[r][q]` directly as an immutable grid, which is already the shape this step declares, so the observation reuses it rather than rebuilding it.

### Action space and masks

The action space is the two-component Dict from the spec: path `Discrete(1555)` (0 stay, 1 through 1554 a move path) and target `Discrete(E + 1)` (0 none). The components are independent by construction: range is checked only at resolution from the path's final tile, and an out-of-range name falls to the automatic strike, so every combination of individually legal component values is legal, which is what the platform requires of a Dict action space.

The mask carries one binary vector per component. The stay and none bits are always 1, the path bits mark exactly the walkable paths, and the target bits mark exactly the nameable targets (alive and visible at activation). A nameable target is not a guaranteed strike. The path mask is built by depth-first walk over legal steps in the six directions, setting bits for the walkable paths; legality is never computed by testing 1554 ids one by one.

`default_action(env, player_id)` returns `{"path": 0, "target": 0}`: stand still, which still strikes when enemies are in range, so a late or crashed agent fights back.

### Observation

Declared exactly as the spec's table: positions as `{"q", "r"}` Dicts, `battlefield.side` plus the square `tiles[r][q]` array with terrain void outside the hex field, seven-tile zone Dicts, rosters, resolved parameters, and no charging field. Spaces are built once from the resolved parameters and never change within an episode.

Gymnasium `Text` spaces have no production precedent in this repo, so a small spike test lands first: it pins `contains()` behavior, the charset, and JSON round-trips for every emitted string field before the full observation is assembled. If Text proves unusable, the fix is an observation-schema revision to the spec, which goes back to the owner before any deviation.

### Match flow, rewards, and results

Dead-step choreography exactly as the spec's Match flow section: a killed player is terminated on the killing transition, exposed for `step(None)` cleanup before the next real activation, and receives no later hook. The final real step terminates (or at the round cap truncates) every player still active. The environment's optional `result_scores()` hook returns every id in `possible_agents` with its side's 0-100 team score after natural completion. The harness validates and caches that complete mapping before closing the environment, so players removed earlier receive the authoritative result without another participant hook.

### Overlay

Self-contained per state and strictly JSON-safe, with a pinned size budget: a full 6000-tick army episode in the full-variant season shape (`field_extent=10`, terrain and abilities enabled, three capture zones, and `round_cap=150`) records to at most 10 MiB. The budget deliberately forces tight encoding: one character per tile combining terrain and feature, fixed-width unit records, and roster-order visibility sets as bitmask strings. If the budget is not reachable with self-contained per-state overlays, the fallback (moving the constant battlefield to the recording header) revises the spec's overlay language and goes back to the owner first. The overlay carries the spec's required content: battlefield, zones, round, capture scores, living units, current activation, per-player visible-unit sets, and the most recent resolved events for animation. Compact overlay version 2 appends each resolved event's exact executed path id, so the renderer can animate every entered tile rather than inferring a straight endpoint route. It does not carry action masks or legal-choice lists: the renderer derives legality from this semantic state.

`current_activation` follows the [environment spec](../environment.md#rendering-and-human-input). The dead-step choreography above is what makes it subtle: derive it from the engine's next living activation rather than from `agent_selection`, which also names players queued for cleanup.

### Chat policy and metadata

The chat policy lists the living allied players in player order, excluding the sender, as direct recipients, with broadcast the default. Metadata is declared complete in this step, inert pieces included:

| Field | Value |
| --- | --- |
| env_id, display_name | skirmish_crane, Skirmish at Crane Reach |
| description | A seeded, turn-based team tactics game in which separately running units coordinate through perception and delayed messages. |
| layout | seat plans skirmish (default) and army |
| builtin_agents | naive (Naive) only; the instructor anchors are later work |
| parameters | field_extent, terrain, wasteland, unit_abilities, capture_zones, capture_target, round_cap per the spec table |
| human_players, human_timeout_ms | all players, 30_000 |
| stepping, pace_interval_ms | sequential, None |
| view_interval_ms, live_interval_ms | 1_000, 1_000 |
| recommended_episode_ticks | 6000 |
| step_limit_ms, episode_limit_ms | 1_000, 600_000 |
| messaging, message_cap | True, 200 |
| llm | False |
| seat_order_matters | True |
| renderer | crane-reach-field (inert until step 3) |

Seasons 1 and 2 silence messaging through the season override, which can only disable or tighten. The forfeit floor is 0, the backend default, so no backend change.

### Naive

Naive is a small, intentionally imperfect baseline. Each instance remembers its own starting tile and treats the point-reflected tile as a rough goal on the enemy side. Every random choice comes from a generator seeded in `reset(seed)`, the seed the environment also receives, so a seeded episode replays exactly.

Each activation, mask-driven throughout:

- With an enemy visible, greedily + randomly choose one of the tiles that will make the resulting distance closer.
- With no enemy visible, consider legal one-step moves only. Choose at random among those that reduce hex distance to the goal, or among all of them when none do. Stay only when no one-step move is legal.

Naive never names a target and leaves strikes to automatic resolution.

## Tests

Under `environments/skirmish_crane/tests/`, mirroring the shared conformance suite through the same harness validators, because the shared suite only ever builds default parameters and therefore only covers skirmish. This local suite permanently owns army-plan and parameter-extreme coverage:

- PettingZoo `api_test` (with the known 1211 tolerance) at both seat plans and at parameter extremes, `observation_space.contains()` on every turn of full episodes, `action_mask_problems` on every emitted mask, and strict JSON round-trips with `allow_nan=False`.
- The Text-space spike, first.
- Emitted masks agree with the engine: a sampled set of masked-1 paths walk successfully, masked-0 paths and targets are rejected by `env.step()`, and the stay and none bits are always 1.
- Dead-step choreography, complete final results for all of `possible_agents`, and the truncation path at a small round_cap.
- Seeded golden rollouts at both plans: same seed and scripted actions produce identical recordings.
- The recording-size test: a full-variant 6000-tick army episode through `run_episode`, using the season field extent of 10 and the shape pinned above, stays at or under 10 MiB.
- A season-table test: every row of the spec's season schedule resolves as a valid parameter payload via `resolve_parameters` against the declared parameters.
- Naive plays full legal games at both plans. Its actions are legal, it takes a one-step move whenever no enemy is visible and one is legal, it pursues visible enemies without naming targets, and two runs at one seed match while different seeds diverge.

## Done when

Full skirmish and army episodes run through the harness with naive in every seat and record to JSONL, the step 1 ASCII runner replays those recordings, the army recording stays within 10 MiB, and the whole local conformance suite is green. The package still does not appear in the entry points or the shared suite.
