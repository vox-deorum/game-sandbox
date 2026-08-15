# Days at Three Branches: PettingZoo Environment

This document defines the PettingZoo representation of the [ruleset](ruleset.md): seats, players, parameters, tick cycle, spaces, scoring, speech, recording, and rendering. It is an internal implementation contract for the [platform environment contract](../../docs/specs/environment.md). The ruleset owns game truth and [village.md](village.md) owns place.

## Seats and players

Every plan has `seat_0`, the cast, and `seat_1`, the visitor.

| Plan    | Title          | Players |
| ------- | -------------- | ------- |
| cast_5  | Five villagers | 6       |
| cast_10 | Ten villagers  | 11      |

| Plan    | Seat                | Ordered players            |
| ------- | ------------------- | -------------------------- |
| cast_5  | seat_0, the cast    | player_1 through player_5  |
| cast_5  | seat_1, the visitor | player_0                   |
| cast_10 | seat_0, the cast    | player_1 through player_10 |
| cast_10 | seat_1, the visitor | player_0                   |

`cast_5` is declared first and is the default. Every layer uses one player-id sequence: `player_0` is the visitor, and `player_1` upward are the NPCs. Roster order, prop contention, `possible_agents`, observations, chat, recordings, helpers, student material, active-player mappings, and conformance use this sequence without translation.

The visitor is identified by `id == "player_0"`. Canonical ids match `player_(0|[1-9][0-9]*)`; leading-zero and legacy aliases are invalid. No observation carries a visitor flag.

The cast seat accepts one submission and constructs a separate instance for every NPC. The visitor seat is restricted to `scripted_visitor`; a human plays its `player_0` in live sessions and the builtin plays it in automated runs. The builtins are `naive` (Naive), the cast baseline, and `scripted_visitor` (Scripted visitor), which wanders, approaches NPCs, and offers canned lines. Seat order does not change the game.

## Gameplay parameters

| Name | Friendly title | Type | Default | Bounds or choices | Description |
| --- | --- | --- | --- | --- | --- |
| seat_plan | Cast size | choice (reserved) | cast_5 | cast_5 (Five villagers), cast_10 (Ten villagers) | Selects the declared seat plan and cast size. |
| daynight | Day and night | bool | false |  | Enables the ruleset's day phases. |

The day is 1200 ticks. There is no prop-density or day-length parameter.

Defaults reproduce Season 1. The schedule resolves as follows.

| Season | seat_plan | daynight | LLM API |
| ------ | --------- | -------- | ------- |
| 1      | cast_5    | false    | off     |
| 2      | cast_10   | false    | off     |
| 3      | cast_10   | false    | off     |
| 4      | cast_10   | true     | off     |
| 5      | cast_10   | true     | on      |
| 6      | cast_10   | true     | on      |

Each row is a declared `META.presets` entry, available in web dialogs and through `--preset season_1` to `--preset season_6`. Tests pin this table. Messaging is always on. LLM API availability is season metadata, not a gameplay parameter. Seasons 2 and 3 share parameters, as do Seasons 5 and 6; their differences are in pedagogy and season configuration.

## Match flow

`reset(seed)` supplies the session seed and first observation through `reset(seed, observation)`. The seed generates the village, and a reset with no seed builds the default village. The engine draws no randomness. Shipped production builtins use fresh entropy, so repeated live builtin sessions with the same seed need not match. A cast agent that needs a character-specific stream may use `me.rng(observation, session_seed)` during reset and perform layout work there rather than inside a decision.

Characters begin in the [ruleset's initial poses](ruleset.md#characters). Props begin unheld in their start state. A fixed layout and action sequence replay identically on the same build.

One ruleset tick is one parallel `env.step()` with a complete player-keyed action map. Characters choose from the same pre-tick state. The engine resolves movement together, then resolves prop contention in character order. Chat hooks run after actions have been collected, as [Speech](#speech) specifies.

The full roster remains active through the day. Tick 1200 terminates every player, rather than truncating the episode. Accumulated rewards are final scores, so there is no `result_scores()` hook.

## Actions

Every player uses the same space in both plans.

```text
Dict{
  "heading": Box(0.0, 360.0, shape=(), float32)  # degrees counterclockwise from east; 360 normalizes to 0
  "speed":   Box(0.0, 1.0, shape=(), float32)    # fraction of the ground's speed limit
  "action":  Discrete(11)                        # 0 none, 1 use, 2 through 10 an emote
}
```

An order applies heading, moves at the relative speed, and resolves expression. Action ids 2 through 10 are the [ruleset emotes](ruleset.md#actions) in table order: wave 2, nod 3, shake_head 4, point 5, laugh 6, shrug 7, startle 8, sleep 9, and sweep 10. `none` and `use` keep the low ids so later emotes extend the tail without renumbering.

`use` selects the nearest interactive prop within ruleset reach and an unblocked line, measured to the nearest point on its collision shape. Ties use canonical prop order. Selection uses the pre-tick pose, commanded speed must be 0, and facing is irrelevant. If the target is missing, held, or unavailable, the expression resolves to none. The agent never names a prop.

Every in-space value is legal in every state, so no action mask is published. Values outside the declared space raise an illegal-participant-action error from `env.step()`. `default_action(env, player_id)` returns the current heading, speed 0, action 0. The harness uses it for a late or missing action.

## Observations

The observation is a plain `Dict` with fixed Gymnasium shapes after parameter resolution. Positions are `{"x", "y"}` Dicts of `Box(0.0, extent, shape=(), float32)` metres. Cell coordinates are `{"x", "y"}` Dicts of `Discrete` over frame cell counts. The extents come from `rules.json`; headings use the action convention.

| Field | Space | Content |
| --- | --- | --- |
| self | Dict | id, position, heading, moved, expression |
| seen | Sequence of Dicts | other characters in the vision cone with an unblocked line: id, position, heading, moved, expression |
| nearby | Sequence of Dicts | other characters in hearing range with an unblocked line: id, position |
| props | Sequence of Dicts | interactive-prop id and state for each prop seen under the cone and line rules |
| bell | Discrete(2) | 1 while the beacon bell rings, at any distance |
| tick | Discrete(1200, start=1) | current tick |
| phase | Text | day phase, or constant day when daynight is off |
| village | Dict | static layout generated at reset |
| roster | Tuple of Dicts | `player_0`, then NPCs from `player_1` upward: id, home |
| parameters | Dict | encoded resolved gameplay parameters |

`moved` is `Box(0.0, 1.0)`, the metres advanced on the latest tick. `nearby` carries presence only; speech is platform messaging. Expressions are `{"type", "target"}` Text fields, where type is none, an emote, or use and target is a prop id or `"none"`. Roster `home` is `Text(max_length=16)`; the visitor's value is `"none"`. Prop entries are `{"prop", "state"}`.

`village` is standing knowledge. Text fields use lowercase letters, digits, and underscores with minimum length 1: player-id capacity is derived from the largest supported cast and therefore admits `player_10`; prop and building ids have maximum length 16; prop types 12; states 9; phase 7; expression type 10. `parameters` contains `seat_plan` as `Text(max_length=7)` and `daynight` as `Discrete(2)`. The `tick` field names the tick whose action will play: reset carries tick 1, and the terminal observation keeps tick 1200. The inbox is not an observation field.

### The village field

| Key | Space | Content |
| --- | --- | --- |
| size | Dict | cells_x and cells_y as `Discrete`, and cell_size as `Box` in metres |
| ground | Tuple of Text | south row first, one ground code character per cell |
| buildings | Tuple of Dicts | id, type, cell |
| props | Sequence of Dicts | id, type, cell, facing |
| scenery | Sequence of Dicts | type, cell |
| spawn | Dict | visitor spawn position in metres |

Ground codes come from `rules.json`, so `ground[cy][cx]` is the class at `(cx, cy)`. That grid contains water, building walls, doorways, and floors. Water and walls are impassable, and only walls block sight. The doorway helper reads doorway cells from the building perimeter.

Building ids are `home_0` through `home_4`, `inn`, and `shed`. Props are in catalog order by type and generation order within type, with ids such as `stall_0`. `facing` is north, east, south, or west. Scenery types are `pine` and `crate`. Catalog types define reservation, extent, collision, and interactive behavior. A prop carries its catalog rectangle turned to its facing, so facing east or west trades its width and height, and the shape stays axis-aligned. Rules that measure to an interactive prop use its catalog collision shape.

Nothing in `village` changes during an episode. The environment retains one immutable snapshot and projects isolated plain mappings for every player and episode. It may share immutable tuples and strings, never a mutable village mapping.

## Rewards and scoring

Every nonterminal reward is 0. On tick 1200 every player, including the visitor, receives 100. The platform's forfeit rules realize the health check: a cast member that crashes, submits an illegal action, or exhausts its episode compute budget forfeits the cast seat to floor 0. A session ending early retains its accumulated 0. A late `act` uses the default action and does not fail.

Every completed day that avoids a forfeit scores 100, so the automated board orders by compute-time tiebreak. People judge believability, as [pedagogy.md](pedagogy.md) defines.

## Speech

A message is a range-limited broadcast or a direct message naming one addressee. Broadcast remains available. Both require hearing range and an unblocked line.

`chat_policy(sender)` supplies `target_recipients`, the reachable characters at the pre-step policy state, and `default_recipient`, `None` for broadcast. A direct message names one permitted target. `broadcast_recipients(sender)` returns the other characters within hearing range and an unblocked line at the end-of-tick delivery state.

Each message has at most 200 code points. A message sent on tick T reaches its recipients during T+1 after they choose actions. The first action it can inform is T+2. Characters keep their inboxes in their own memory.

Watchers and replay viewers see every delivered line. The visitor controller sees broadcasts delivered to `player_0` and direct lines sent to or from `player_0`.

## Rendering and human input

The `three-branches-village` renderer draws from the recording overlay and admitted messages. It has no fog. Active prop state drives sustained animation: lanterns and hearths glow, tended shrines trail incense, pumps flow, and the bell swings. Live sessions emit an opening presentation state so the village renders before tick 1.

The permanent viewer-toggleable collision overlay appears in watch, replay, and play, off by default and toggled by a chrome button or the C key. It shades impassable ground, draws catalog collision shapes for interactive props and scenery, keeps doorways visibly open, and shows characters as 0.4 m circles with heading tick, id, and expression label. Interactive props show state labels.

On the visitor seat, pointer and keyboard input compose locomotion. The expression palette offers emotes and use, highlighting the prop a use would select without sending an action. The 250 millisecond cadence is the input window. The host-page chat field has a recipient selector: broadcast or one currently permitted addressee, carried as a canonical player id and shown with the host's standard compact label. Spectators and replay viewers have no input.

## Recording

A recording is one JSONL file: one header line followed by one line per recorded transition. The header writes `overlay_static` once, in exactly the observation's `village` shape. It contains `size`, `ground`, `buildings`, `props`, `scenery`, and `spawn`. At the shipped 120 by 120 frame it is about 20 KB.

Each transition writes a dynamic overlay with `tick`, `phase`, `characters`, `props`, and `terminal`. `characters` must match the header's exact ordered player roster, with `id`, `x`, `y`, `heading`, `moved`, and `expression`. Message endpoints must be exact roster members, except that a null recipient is a broadcast. `props` maps every interactive prop id to its state, including the bell. No dynamic state carries `village`. Recordings with legacy `visitor` or `npc_i` ids are unsupported.

```json
{
  "tick": 412,
  "phase": "morning",
  "characters": [{ "id": "player_0", "x": 34.12, "y": 50.5, "heading": 90.0, "moved": 0.75, "expression": { "type": "wave", "target": "none" } }],
  "props": { "stall_0": "open", "bell": "silent" },
  "terminal": false
}
```

Encoding rounds positions and `moved` to centimetres and headings to a tenth of a degree. This makes a replayed frame identical to its live frame. A cast_10 overlay is estimated at about 1.6 KB per tick, or about 2 MB for a full day. The provisional 10 MiB environment target is untested. It is not a platform limit or a pass/fail criterion.

The recording is plain JSON and uses ruleset vocabulary. The renderer reads it through declared TypeScript types and checks the top-level shape once at mount.

## Platform metadata

| Entry | Value |
| --- | --- |
| Environment id | three_branches |
| Display name | Days at Three Branches |
| Description | A seeded village day in which separately running NPCs make one village feel alive around a human-played visitor. |
| Layout | seat plans cast_5 and cast_10 |
| Builtin agents, in order | naive (Naive), scripted_visitor (Scripted visitor) |
| Gameplay parameters | Gameplay parameter declarations; seat_plan is synthesized from layout |
| Human-capable players | player_0, the visitor in every plan |
| Human move clock | none; a simultaneous environment paces instead |
| Stepping | simultaneous |
| Pace interval | 250 milliseconds |
| Viewing cadence | 250 milliseconds per recorded transition |
| Live playout cadence | none; simultaneous game |
| Recommended episode ticks | 1200 (`META.recommended_episode_ticks`) |
| Compute limits | 0.25 seconds per decision, 120 seconds per game |
| Messaging | available; text limit 200 code points |
| LLM API | available; off by default, enabled by Seasons 5 and 6 |
| Seat order | does not change the game |
| Forfeit floor | 0 |
| Renderer | three-branches-village |

`naive` is the platform baseline. Compute limits are environment defaults that a season may override; verified LLM proxy waits do not count. The template's background-request helper carries Season 5 dialogue across ticks.

The pace interval is a floor, not a promise. The simultaneous harness calls `act` sequentially on one thread, per [execution.md](../../docs/specs/execution.md). A cast_10 day reaches the 250 millisecond cadence only when all eleven decisions fit inside that window. Setup also runs sequentially, so shipped examples keep reset-time graph work modest.

## Package and student materials

The implementation includes the factory, default action, overlay extractor, registry entry, renderer, canonical guide, template helpers, and at least one worked example. It declares `PUBLISHED_EXAMPLES`, even when every early example is internal.

`sandbox.village` follows `sandbox.crane`: students import small namespaces individually, and helpers are stateless readers or pure builders. Observation readers and static-map queries accept the observation first. Action builders, geometry functions, and player-id predicates take no observation. Nothing carries state between ticks.

| Namespace | Provides |
| --- | --- |
| `action` | `EMOTES`, `walk(heading, speed=1.0, expression="none")`, `stand(heading, expression="none")`. Both wrap heading and clamp speed; expression is `"none"`, an emote, or `"use"`. |
| `me` | `player_id`, `position`, `heading`, `moved`, `expression`, `home`, `rng(observation, session_seed)`. |
| `people` | `seen`, `nearby`, `roster`, `is_visitor(player_id)`, and `is_npc(player_id)`. |
| `props` | `all`, `seen`, `in_reach`, `usable`, and `TYPES` from `catalog.json`. |
| `layout` | `frame`, `cell_at`, `ground_at`, `walkable`, `can_step`, `line_of_sight`, `buildings`, `building`, `doorway`, `spawn`, and `SPEED_LIMITS`. |
| `geometry` | `BODY_RADIUS`, `VISION_RANGE`, `VISION_DEGREES`, `HEARING_RANGE`, `PROP_REACH`, `distance`, `heading_to`, `wrap`, and `in_cone`. |
| `day` | `tick`, `phase`, `bell_ringing`, `parameters`. |

`layout.line_of_sight` walks the ground grid and only wall cells block it. `can_step` checks a straight static-map step against impassable ground, catalog prop shapes, and the boundary, ignoring characters. `walkable` checks whether a body can stand at a point. Both use the engine's grid and catalog shapes.

No helper chooses a behavioral destination or companion. `props.usable` mirrors the engine's pre-action prop candidate, but no controller or pathfinder is published. `observation["village"]` supplies the complete static map, and `walkable`, `can_step`, and `ground_at` provide a route planner's node test, edge test, and edge cost. Season 4's starter example owns routing.

`me.rng` seeds `random.Random` through a stable hash of session seed and player id. The same pair yields the same stream, different ids yield different streams, and streams are stable across runs. `people.is_visitor` accepts only `player_0`; `people.is_npc` accepts canonical positive-number player ids and does not imply current roster membership.

Helpers are pin-tested against the engine or data contract, including isolation between agents and the internal snapshot. The Stage 2 suite uses six contract-focused modules for data and math, layout and physics, engine behavior, environment and chat, overlays and builtins, and complete-day replay. Renderer tests cover direct seeks and human controls once the production renderer lands. Course materials link students to public platform documentation, not internal specifications.

## Conformance notes

- The environment passes PettingZoo `parallel_api_test` and the platform's stricter parallel subset. After reset, the active set covers resolved players in player order until all terminate at tick 1200. Every accepted or returned mapping covers that set.
- `observation_space.contains()` holds for every observation. Sequence fields are tuples, Dicts have declared keys only, and Text respects declared charsets.
- Spaces are built once from resolved parameters. The default action is contained and legal in every reachable state. No action mask is published.
- Overlay values are finite and JSON-safe. Recorded actions and messages normalize to plain JSON.
- The design depends on mask-free `Dict` actions in simultaneous environments, bounded messaging, live watcher visibility, and live-session lifetime rules. [Platform contract expansions](stages/1-platform-expansions.md) owns the implementation boundary.
