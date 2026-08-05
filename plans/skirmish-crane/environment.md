# Skirmish at Crane Reach: PettingZoo Environment

This document defines how the [ruleset](ruleset.md) appears through the platform's PettingZoo interface: seats and players, gameplay parameters, the agent-environment cycle, the action and observation spaces, scoring, and messaging. It is an internal design document for the environment implementation, written against the [platform environment contract](../sandbox-doc/specs/environment.md). The ruleset stays the source of game truth; this document only fixes the representation.

## Seats and players

The environment declares seat plans. seat_0 is Red and seat_1 is Blue in every plan.

| Plan     | Title    | Per side                        | Players |
| -------- | -------- | ------------------------------- | ------- |
| skirmish | Skirmish | 1 footman, 1 archer, 1 cavalry  | 6       |
| army     | Army     | 8 footmen, 6 archers, 6 cavalry | 40      |

| Plan     | Seat         | Ordered players             |
| -------- | ------------ | --------------------------- |
| skirmish | seat_0, Red  | player_0 through player_2   |
| skirmish | seat_1, Blue | player_3 through player_5   |
| army     | seat_0, Red  | player_0 through player_19  |
| army     | seat_1, Blue | player_20 through player_39 |

skirmish is declared first and is the default. Red covers the first half of the players and Blue the second. Within a side, players run footmen first, then archers, then cavalry, in index order, so unit ids follow from player positions alone. In the army plan, player_0 through player_7 are red_footman_0 through red_footman_7, player_8 through player_13 are the red archers, player_14 through player_19 the red cavalry, and player_20 through player_39 repeat the order for Blue. Every observation carries the full rosters, so agents never recompute this mapping.

Seat order matters: the field is symmetric, but a fixed seed gives the two seats different spawn halves and activation draws, so swapping agents changes the match.

## Gameplay parameters

| Name | Friendly title | Type | Default | Bounds or choices | Description |
| --- | --- | --- | --- | --- | --- |
| seat_plan | Army size | choice (reserved) | skirmish | skirmish (Skirmish), army (Army) | Selects the declared seat plan and unit roster. |
| field_extent | Field extent | int | 7 | 5 to 22 | Sets the field radius: the hex distance from the center tile to the field edge. |
| terrain | Terrain | bool | false |  | Enables water, hills, forests, and marshes. |
| wasteland | Wasteland | bool | false |  | Scatters magical waste that wounds any unit entering it. Needs terrain. |
| unit_abilities | Unit abilities | bool | false |  | Enables cavalry charge and footman shield wall. |
| capture_zones | Capture zones | int | 0 | 0 to 5 | Sets the number of scoring zones; zero disables capture play. |
| capture_target | Capture target | int | 200 | 10 to 10000 | Sets the capture score needed to end a capture match. |
| round_cap | Round cap | int | 1000 | 100 to 10000 | Sets the maximum number of completed rounds. |

- field_extent is the ruleset's field radius: the field holds 3 × field_extent^2 + 3 × field_extent + 1 tiles and measures 2 × field_extent + 1 tiles across (169 tiles, 15 across at the default; 331 tiles, 21 across at extent 10).
- terrain switches the terrain variant, wasteland switches the wasteland variant and needs terrain on to have any effect, unit_abilities switches the abilities variant, and a capture_zones value above 0 switches the capture variant. capture_target is inert at 0 zones.
- Zone placement generalizes the ruleset symmetrically to any count: an odd count places one central zone, and the rest are placed as mirrored pairs. The field always has a center tile, so a central zone fits any declared field_extent and every declared parameter combination is constructible.
- Messaging is platform metadata that a season toggles, not a gameplay parameter.
- round_cap sets the ruleset's round cap.

Defaults reproduce Season 1. The season schedule resolves to:

| Season | seat_plan | field_extent | terrain | wasteland | unit_abilities | capture_zones | messaging |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | skirmish | 7 (15 across) | false | false | false | 0 | off |
| 2 | skirmish | 7 (15 across) | true | false | false | 0 | off |
| 3 | army | 10 (21 across) | true | false | true | 0 | on |
| 4 | army | 10 (21 across) | true | false | true | 1 | on |
| 5 | army | 10 (21 across) | true | false | true | 3 | on |
| 6 | army | 10 (21 across) | true | true | true | 3 | on |

capture_target stays 200 and round_cap stays 1000 in every season.

## Match flow

`reset(seed)` generates the battlefield and rosters and draws round 1's activation order. The same seed and action sequence reproduce the same match, per the ruleset's determinism rule.

One living-unit activation is exactly one real `env.step()`. `agent_selection` walks the round's activation order. The round's last real step also runs capture scoring, checks the end conditions, and draws the next round's order when the match continues.

A killed unit leaves the battlefield and activation order immediately. Its player is marked terminated on the transition that killed it. Before the next real activation, the environment exposes that player for the required `step(None)` dead-step cleanup, which removes it from `env.agents`. The harness invokes no participant hook and records no separate state for that cleanup. A killed player therefore becomes inactive for actions, learning, direct messages, broadcasts, and human chat.

When an end condition is reached, the final real step marks every player still active as terminated. At the round cap it marks them truncated instead. The harness performs the required `step(None)` cleanup for those players, and the episode ends when `env.agents` is empty. The environment retains result data for every id in `possible_agents`, including players removed earlier, so the reported match result can assign the final team score to the complete roster.

The environment truncates at round_cap rounds, which is the ruleset's round cap; scores follow the ruleset's round-cap rules.

## Actions

The action space is the same `Dict` for every player constructed under the same seat plan. E is the enemy roster size, 3 in skirmish and 20 in army. Every action is a Dict with two components:

```text
Dict{
  "path": Discrete(1555)     # 0 stay, 1 through 1554 a move path
  "target": Discrete(E + 1)  # 0 none, i the enemy roster slot i - 1
}
```

One action is one complete ruleset order: the unit walks the path, then strikes from its final tile under the ruleset's strike rules. Path ids 1 through 1554 name every sequence of one through four directions from 1 through 6, because 6 + 6^2 + 6^3 + 6^4 = 1554. They are ordered first by path length and then lexicographically, with the last direction varying fastest. This order is part of the stable student contract and is covered by helper pin tests.

| Digit | Direction | dq, dr |
| ----- | --------- | ------ |
| 1     | northeast | 1, -1  |
| 2     | east      | 1, 0   |
| 3     | southeast | 0, 1   |
| 4     | southwest | -1, 1  |
| 5     | west      | -1, 0  |
| 6     | northwest | 0, -1  |

Digits run clockwise from northeast, so a direction's opposite is found by adding 3 and wrapping 7, 8, and 9 back to 1, 2, and 3. Rotating a path through 180 degrees keeps the digit order and opposes each digit. Retracing a path reverses the digit order and opposes each digit, so `[1, 2]` retraces as `[5, 4]`.

Four directions per path suffice: the highest movement stat is 4 and every step costs at least 1, so no unit can execute a fifth step. A path value is legal exactly when the unit can walk the complete path from the current state under the movement rules, and stay is always legal. A target value is legal exactly when its roster slot is alive and visible at activation, and none is always legal. The components are independent by construction: range is checked only at resolution, from the path's final tile, and an out-of-range name falls to the ruleset's automatic strike, so every combination of individually legal component values is legal, which is what the platform requires of a `Dict` action space.

Every observation carries an authoritative action mask with one binary vector per action component. The stay bit and the none bit are always 1, and the remaining path and target bits mark exactly the walkable paths and the nameable targets. A target masked 1 is nameable, not a guaranteed strike. `env.step()` rejects an action outside the `Dict` space and rejects one any of whose components is masked 0. Such an action is an illegal participant action. The environment entry's `default_action(env, player_id)` returns `{"path": 0, "target": 0}`, stand still, which is legal in every reachable state and is what the harness uses for a late or missing action. Per the ruleset, that order still strikes when enemies are in range, so a late or crashed agent fights back automatically.

Target values index the acting player's enemy roster in player order, value i naming slot i - 1, so the same value names a different unit for Red and Blue. The agent template ships `encode_path(directions)` and `decode_path(path_id)` for the complete 0 through 1554 codec. An empty path uses 0, and invalid directions or ids raise `ValueError`. Its `move(path_id, target_id=None, observation=None)` and `stay(target_id=None, observation=None)` helpers return action Dicts and resolve a target id to its roster slot through the observation. It also provides `legal_paths(observation)` and `nameable_targets(observation)`, both driven by the authoritative mask rather than by a second implementation of the rules.

## Observations

The top-level observation follows the platform's masked-action convention:

```text
Dict{
  "observation": Dict{...meaningful game state...}
  "action_mask": Dict{
    "path": MultiBinary(1555)
    "target": MultiBinary(E + 1)
  }
}
```

Its schema is fixed by the resolved parameters at construction and stays constant for the whole episode. Positions everywhere are `{"q", "r"}` Dicts whose coordinates are `Discrete(field_side)`, where `field_side = 2 * field_extent + 1`.

| Field | Space | Content |
| --- | --- | --- |
| self | Dict | unit_id, type, position, hit_points, movement_points |
| visible_units | Sequence of Dicts | every other unit within vision, in player order: unit_id, side, type, position, hit_points |
| round | Discrete | the current round number, from 1 through round_cap |
| capture | Dict | scores for red and blue and the target; all 0 when the capture variant is off |
| battlefield | Dict | side, tiles, zones; generated at reset and constant |
| rosters | Dict | red and blue: Tuples of {player, unit_id, side, type} |
| parameters | Dict | encoded values for every resolved gameplay parameter |

- Text fields use lowercase letters, digits, and underscore. `unit_id` is `Text(max_length=16)`, `player` is `Text(max_length=9)`, `side` is `Text(max_length=4)`, and `type` is `Text(max_length=7)`. Every Text field has minimum length 1.
- `hit_points` is `Discrete(13)` and `movement_points` is `Discrete(5)`.
- `round` is `Discrete(round_cap, start=1)`. Each capture score is `Discrete(capture_target + max(1, capture_zones))`, which includes the largest score reachable on the round that crosses the target. The capture target is `Discrete(capture_target + 1)`.
- battlefield.tiles is a Tuple of field_side rows, each a Tuple of field_side tile Dicts `{"terrain", "feature"}`, indexed tiles[r][q]. terrain is grass, hill, water, or void and feature is none, forest, marsh, or waste. Cells outside the hexagonal field hold terrain void and feature none; void is impassable and never occurs inside the field. battlefield.zones is a Tuple of capture_zones zone Dicts `{"center", "tiles"}` listing each zone's center and its seven tile positions.
- In `battlefield.tiles`, terrain is `Text(max_length=5)` and feature is `Text(max_length=6)`, both with minimum length 1. These declared bounds do not change with wasteland: "waste" is five characters, inside the existing feature bound. battlefield.side is `Discrete(field_side + 1)` and always contains field_side; the tile array is square, so one field describes it.
- `parameters` contains `seat_plan` as `Text(max_length=8)`; `field_extent` as `Discrete(18, start=5)`; `terrain`, `wasteland`, and `unit_abilities` as `Discrete(2)` flags; `capture_zones` as `Discrete(6)`; `capture_target` as `Discrete(9991, start=10)`; and `round_cap` as `Discrete(9901, start=100)`.
- visible_units excludes the observing unit itself and is emitted as a tuple.
- movement_points always equals the type's movement stat, since a unit starts every activation with full points and an activation is a single step.
- `action_mask` carries one binary vector per action component, in that component's value order. The stay bit and the none bit are always 1. A player receives no later observation after it terminates.
- The inbox is not part of the observation; messages travel through the platform chat hook.

## Rewards and scoring

Every nonterminal reward is 0. A player killed before match end receives 0 on its terminating transition and no later `learn` call. On the final real transition, every player still active receives its side's team score as terminal reward.

The reported match result is authoritative for official scoring. It assigns every player in `possible_agents`, including players terminated earlier, its side's final team score from 0 to 100. The mean of the player scores in a seat therefore equals the team score. Replay standings use this complete result rather than treating an earlier cumulative reward as the killed player's final official score. A forfeited seat scores 0, at or below every honest outcome.

Training that needs the eventual team outcome for a unit killed early reads it from the recording after the session. The platform intentionally invokes no participant hook after a player becomes inactive.

## Messaging

The messages variant maps onto the platform messaging layer, so it changes neither the action nor the observation space.

- The environment's recipient policy lists the living allied players, in player order and excluding the sender, as direct recipients. Broadcast is always available and is the default recipient; both sides hear it, per the ruleset.
- At its activation a unit is asked for its order first, and immediately afterward the harness hands its program every message that arrived since its previous activation. A message therefore arrives during the recipient's next activation, but after that activation's order is chosen; the first order that can react to it is the following one. A unit keeps its inbox in its own memory between activations.

## Rendering and human input

The `crane-reach-field` renderer draws only from the semantic overlay. The overlay is self-contained so live play and a replay seek to the same state produce the same frame. It contains:

- The battlefield, capture zones, round, capture scores, living units, current activation, and the visible-unit ids for each living player.
- The most recent resolved move, attack, damage, death, and capture-score changes for optional animation. Compact overlay version 2 includes the exact executed path id for each resolved event, allowing movement through every entered tile.

The production overlay contains no observations, action masks, or legal-choice lists. `current_activation` identifies the next living player who can take a real action. PettingZoo cleanup selections never appear as activations, and `current_activation` is null only after the match ends.

The renderer reads the players this viewer controls from `controlledPlayers`, and their seat from the recording header's seat map. On a human-controlled player's turn, it shows that player's perspective. On a companion's turn, it shows the companion's perspective. On an opponent's turn, it shows the union of the visible sets of every living player on the human's side. Spectators, replays, and terminal states show the complete board.

On a human turn, the renderer computes the acting controlled player's walkable paths and full nameable target set from the overlay state. The human can compose and revise a path, including the empty stay path, and submit it with `target: 0`. From the projected final tile, an informational automatic-strike preview shows a unique nearest in-range enemy, marks tied nearest candidates as uncertain, or shows nothing when no enemy is in range. The preview neither sends an action nor advances the match. The full target set remains part of the action-mask contract for agents. Spectators and replay viewers receive no action sender.

A human controls either the primary player in the selected seat or the whole side; all players are declared human-capable. When the human controls the primary player, the seat's other members use separately constructed instances of the selected companion agent. A human controlling the whole side needs no companion.

## Platform metadata

| Entry | Value |
| --- | --- |
| Environment id | skirmish_crane |
| Display name | Skirmish at Crane Reach |
| Description | A seeded, turn-based team tactics game in which separately running units coordinate through perception and delayed messages. |
| Layout | seat plans skirmish and army |
| Builtin agents, in order | naive (Naive), bronze (Bronze), silver (Silver), gold (Gold) |
| Gameplay parameters | the declarations in Gameplay parameters, with friendly titles and descriptions; seat_plan is synthesized from the layout |
| Human-capable players | all players; default move clock 30 seconds |
| Stepping | sequential |
| Pace interval | none; the game is turn-based |
| Viewing cadence | 1000 milliseconds per recorded transition |
| Live playout cadence | 1000 milliseconds per nonhuman transition |
| Recommended episode length | 6000 ticks |
| Compute limits | 1 second per decision, 600 seconds per game |
| Messaging | available; text limit 200 code points |
| LLM API | off |
| Seat order | changes the game |
| Forfeit floor | 0 |
| Renderer | crane-reach-field |

The four builtins are separately declared agents. `naive` is the platform baseline required on every board, while bronze, silver, and gold are the instructor anchors used by the course. The first implementation ships `naive` alone; the anchors are later work, added before the course needs them. Season configurations may assign any declared builtin to an unrestricted seat.

All players are human-capable so a student can control a side's primary unit, with a companion agent filling the rest, or the whole side. Season 5 may use the controlled units' decision streams as one source of imitation-learning demonstrations ([pedagogy.md](pedagogy.md)), covering the primary unit's stream or the whole side's; agent-generated demonstrations cover the rest. Compute limits are environment defaults a season may override.

## Package and student materials

The platform implementation includes the environment factory, default action, overlay extractor, registry entry, renderer, canonical student guide, template layer, and at least one worked example. Its package declares `PUBLISHED_EXAMPLES` explicitly, even when the first implementation keeps every worked example internal. The template's crane helper module owns the stable path encoding and has pin tests against the environment decoder. Environment tests cover rules, scripted seeded rollouts, masks, immediate player termination, complete final results, both seat plans, and the battlefield guarantees at parameter extremes. Renderer tests cover direct replay seeks, every human control, and agreement between the renderer's legality calculation and test-only fixture masks. Course materials point students to the published platform documentation rather than the internal Sandbox specifications.

## Conformance notes

- The environment passes PettingZoo's api_test, including immediate dead-step cleanup, and `observation_space.contains()` holds for every wrapped observation across a full episode.
- Sequence fields are emitted as tuples, every Dict carries exactly its declared keys, and Text fields stay within the declared charset.
- Spaces are built once from the resolved parameters and never change within an episode.
- Every emitted mask carries one binary vector per action component, each the length of its component's space, containing only 0 and 1, with the stay and none bits 1. The action space declares only permitted composite child types, and the environment is sequential, so PettingZoo's `api_test` handles the object mask. The default action is contained in the action space and legal in every reachable state.
- Overlay values are finite and JSON-safe.
- The environment reports final scores for every id in `possible_agents`, including players removed before the last transition.
