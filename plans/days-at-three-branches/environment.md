# Days at Three Branches: PettingZoo Environment

This document defines how the [ruleset](ruleset.md) appears through the platform's PettingZoo interface: seats and players, gameplay parameters, the tick cycle, the action and observation spaces, scoring, speech, and rendering. It is an internal design document for the environment implementation, written against the [platform environment contract](../../docs/specs/environment.md). The ruleset stays the source of game truth and [village.md](village.md) the source of place; this document only fixes the representation. It assumes the contract expansions listed in the conformance notes.

## Seats and players

The environment declares seat plans. seat_0 is the cast and seat_1 is the visitor in every plan.

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

cast_5 is declared first and is the default. There is one character order in this game and the player numbering is that same order: the visitor is character 0 and `player_0`, and `npc_i` is character i+1 and `player_(i+1)`. Roster order, same-tick prop contention, `possible_agents`, active-player mappings, and platform conformance all read that single order, so nothing anywhere has to reconcile two of them.

Player ids stay inside the environment. No observation field, helper, or student document names one, so an agent works in character ids alone: npc_0 through npc_9 and visitor. A character is the visitor exactly when its id is `visitor`, which is why no observation carries a visitor flag.

The cast seat takes one submission, and every NPC runs a separately constructed instance of it, differentiated only by the id it reads from its observation. The visitor seat is restricted to the scripted_visitor builtin and its player is human-capable: a human plays the visitor in live sessions, and the builtin plays it in automated runs. Two builtins are declared: naive (Naive), the platform baseline that fills the cast seat in automated schedules, and scripted_visitor (Scripted visitor), which wanders the village, approaches NPCs, and offers a few canned lines. Seat order does not change the game, since the plans hold one unrestricted seat.

## Gameplay parameters

| Name | Friendly title | Type | Default | Bounds or choices | Description |
| --- | --- | --- | --- | --- | --- |
| seat_plan | Cast size | choice (reserved) | cast_5 | cast_5 (Five villagers), cast_10 (Ten villagers) | Selects the declared seat plan and cast size. |
| daynight | Day and night | bool | false |  | Enables the ruleset's day phases. |

The day is fixed at 1200 ticks. Village prop inventory is generated from the seeded road and accessory candidates, so it has no gameplay density or length parameter.

Defaults reproduce Season 1. The season schedule resolves to:

| Season | seat_plan | daynight | LLM API |
| ------ | --------- | -------- | ------- |
| 1      | cast_5    | false    | off     |
| 2      | cast_10   | false    | off     |
| 3      | cast_10   | false    | off     |
| 4      | cast_10   | true     | off     |
| 5      | cast_10   | true     | on      |
| 6      | cast_10   | true     | on      |

Each row ships as a declared `META.presets` entry, choosable in the web dialogs and with `--preset season_1` through `--preset season_6`. Tests pin the table. Messaging is on in every season, and LLM API availability is platform metadata a season toggles, not a gameplay parameter. Seasons 2 and 3 resolve identically, as do 5 and 6: what those seasons change lives in pedagogy and season configuration rather than in parameters.

## Match flow

`reset(seed)` uses the session seed for village generation. The environment draws no randomness after generation. Every agent receives that same seed, and its first observation with it, through `reset(seed, observation)`. The scripted visitor uses the seed directly. A cast agent that wants an NPC-specific random stream builds it there with the template's `me.rng(observation, session_seed)`, which reads the character id for it, and an agent with layout work to do does that there too rather than inside a decision. Characters start in the ruleset's initial pose (each NPC on its home's floor facing the doorway with housemates spaced apart, the visitor at the road spawn facing into the village, everyone still with expression none), and every prop starts unheld in its start state. The same seed and action sequence replay identically, per the ruleset's determinism rule.

The environment is simultaneous: one ruleset tick is one parallel `env.step()` with a complete player-keyed action map. Every character selects from the same pre-tick state, and the engine resolves all actions together: movement through the physics engine, prop contention in character order. Within a tick the harness collects every action first and runs chat hooks after, so speech follows action selection, as the speech section describes.

Nobody leaves the village early: the active set is the full roster for the whole day. On tick 1200 the environment marks every player terminated (the day's end is natural completion, not truncation) and the episode ends. Accumulated rewards are the final scores, so no `result_scores()` hook is needed.

## Actions

The action space is the same `Dict` for every player in both plans:

```text
Dict{
  "heading": Box(0.0, 360.0, shape=(), float32)  # degrees counterclockwise from east; 360 normalizes to 0
  "speed":   Box(0.0, 1.0, shape=(), float32)    # fraction of the ground's speed limit
  "action":  Discrete(11)                        # 0 none, 1 use, 2 through 10 an emote
}
```

One action is one complete ruleset tick order: the new heading applies, the character moves at the relative speed, and the expression resolves. Ids 2 through 10 are the ruleset's emotes in table order: wave 2, nod 3, shake_head 4, point 5, laugh 6, shrug 7, startle 8, sleep 9, sweep 10. none and use keep the low ids so later emotes extend the tail of the space without renumbering.

A use acts on the nearest interactive prop by distance to the nearest point of its collision shape among the interactive props within the ruleset's reach with an unblocked line to that point; ties break by canonical prop order. Facing is not part of the test. Selection is judged on the pre-tick pose, the same state the observation shows, and a use needs commanded speed 0, per the ruleset, so the template's `props.usable` helper and the renderer preview are exact. The agent never names a prop, so the space carries no prop dimension. After selection the ruleset's availability rules apply: no qualifying prop resolves to none, a held prop resolves to none, and same-tick contention goes to the first character in character order.

Every value inside the space is legal in every state, because commanded values degrade rather than fail, per the ruleset; the environment therefore publishes no action mask. A value outside the space (a missing key, a wrong dtype, an out-of-bounds number) is rejected by `env.step()` as an illegal participant action, so degradation applies only inside the declared bounds. The environment entry's `default_action(env, player_id)` returns the player's current heading, speed 0, action 0: stand still, which is legal in every reachable state, is what the harness plays for a late or missing action, and is exactly the ruleset's default.

## Observations

The observation is a plain `Dict`: with no action mask there is no wrapper. Its schema and Gymnasium shapes are fixed by the resolved parameters at construction and stay constant for the whole episode. Positions everywhere are `{"x", "y"}` Dicts of `Box(0.0, extent, shape=(), float32)` metres, where each extent is the frame's cell count times its cell size, read from `rules.json`. Cell coordinates are `{"x", "y"}` Dicts of `Discrete` over the frame's cell counts. Headings use the action convention.

| Field | Space | Content |
| --- | --- | --- |
| self | Dict | id, position, heading, moved, expression |
| seen | Sequence of Dicts | every other character in the vision cone with an unblocked line: id, position, heading, moved, expression |
| nearby | Sequence of Dicts | every other character in hearing range with an unblocked line: id, position |
| props | Sequence of Dicts | interactive-prop id and state for every prop seen under the cone and line rules |
| bell | Discrete(2) | 1 while the beacon bell rings, whatever the distance |
| tick | Discrete(1200, start=1) | the current tick |
| phase | Text | the day phase; the constant day when daynight is off |
| village | Dict | the static layout, generated at reset and constant |
| roster | Tuple of Dicts | the visitor, then NPCs from npc_0 upward: id, home |
| parameters | Dict | encoded values for both resolved gameplay parameters |

- `moved` is `Box(0.0, 1.0)`, the metres the character advanced on the latest tick. It is a distance; the action's `speed` is a fraction of the ground's limit. The ruleset reads above 0.5 as running.
- `nearby` is presence by sound, id and position only. The lines characters speak travel through the messaging layer, not this field.
- An expression is `{"type", "target"}`, both Text: type is none, an emote name, or use, and target is the id of the prop in use or the literal `"none"`.
- In roster, `home` is `Text(max_length=16)`: an NPC carries its home building id and the visitor carries the literal `"none"`.
- props entries are `{"prop": Text, "state": Text}`, naming an interactive prop by its id. States use the ruleset's state words. Every perception rule is applied by the environment, so these fields contain exactly what the ruleset lets the character perceive.
- village is the ground grid plus the props standing on it, and it carries the ruleset's full standing knowledge. Its keys are below.
- Text fields use lowercase letters, digits, and underscore, minimum length 1: character ids are `Text(max_length=8)`, prop and building ids `Text(max_length=16)`, prop types `Text(max_length=12)`, states `Text(max_length=9)`, phase `Text(max_length=7)`, expression type `Text(max_length=10)`.
- `parameters` contains `seat_plan` as `Text(max_length=7)` and `daynight` as `Discrete(2)`.
- tick names the tick the observation's action will play in: the reset observation carries tick 1, and the terminal observation of the final step keeps tick 1200.
- The inbox is not part of the observation; speech travels through the platform messaging layer.

### The village field

| Key | Space | Content |
| --- | --- | --- |
| size | Dict | cells_x and cells_y as `Discrete`, and cell_size as `Box` in metres |
| ground | Tuple of Text | one row per cell row, south row first, one ground code character per cell |
| buildings | Tuple of Dicts | id, type, cell |
| props | Sequence of Dicts | id, type, cell, facing |
| scenery | Sequence of Dicts | type, cell |
| spawn | Dict | the visitor's spawn position in metres |

Ground codes are `rules.json`'s single characters, so `ground[cy][cx]` is the class of cell `(cx, cy)` and the whole map is one indexed lookup: speed, passability, and sight all come from it. Water and wall cells are impassable, wall cells are the only ones that block a line, and a building's floor, walls, and doorway are all ground, so nothing outside this grid describes a building's geometry. The doorway helper reads the doorway cells off the building's own perimeter.

Building ids are home_0 through home_4, inn, and shed. Props are in canonical catalog order by type and generation order within type, with ids the type token plus the index in that order, stall_0 upward. `facing` is one of north, east, south, or west. Scenery type tokens are pine and crate.

Catalog types determine reservation, drawing extent, collision, and interactive behaviour. Every rule that measures to an interactive prop measures to the nearest point of its catalog collision shape, so a helper combining this record with `catalog.json` computes the same reach the engine does.

Nothing in village changes during an episode. The environment keeps one immutable internal snapshot, then projects it into isolated plain observation mappings for each player and episode. Immutable tuples and strings may be shared, but no player or episode receives a shared mutable village mapping.

## Rewards and scoring

Every nonterminal reward is 0. On the final tick every player, the visitor included, receives 100. The ruleset's health check is realized by the platform's forfeit rules rather than computed in the environment: a crash, an illegal action, or an exhausted episode compute budget by any cast member forfeits the whole cast seat at the forfeit floor 0, and a session that ends before the day does keeps its accumulated 0. A single late `act` is not a failure: the harness plays the default action and the day goes on. Every honest completed day scores 100, so the automated board orders by its compute-time tiebreak, which is the intended reading: believability is judged by people, per [pedagogy.md](pedagogy.md).

## Speech

The ruleset gives speech one range and no addressee, so every line is one message form: a broadcast the environment bounds.

- The environment implements `broadcast_recipients(sender)`, returning the characters within hearing range of the sender with an unblocked line. It declares no `chat_policy`, because there are no direct messages to rank.
- Because every line is a broadcast, every client receives every delivered line under the platform's ordinary rules: watchers by the visibility rule, and the human playing the visitor as a controller receiving broadcasts. There is nothing to decide about what a playing visitor may see, and the chat UI needs no recipient control.
- A character may send one line per tick, up to 200 code points.
- A line recorded on tick T reaches its hearers' inboxes during tick T+1, after that tick's actions are chosen, so the first action that can react to a line is tick T+2's. A character keeps its inbox in its own memory between ticks.
- Audiences resolve at end-of-tick state, since delivery happens after the step.

## Rendering and human input

The three-branches-village renderer draws from the semantic overlay and the state's admitted messages. The overlay is self-contained, so live play and a replay seek to the same state produce the same frame: the recording's header carries the whole static village once, and each state carries every character's position, heading, distance moved, and expression, every interactive-prop state, the tick, and the phase. Active prop states render as sustained animation, derived from the state alone: a lit lantern glows, the lit hearth burns, a tended shrine trails incense smoke, the flowing pump pours, and the ringing bell swings. There is no fog: every viewer, the human visitor included, sees the whole village and reads every line, because the game is judged by watching it. Every live session emits the opening presentation state, so the village renders before the first tick.

Above the village sits one viewer-toggleable collision overlay: impassable ground cells are shaded, which is exactly the water and the building walls; catalog collision shapes are drawn for interactive props and scenery; doorway ground stays visibly open; and characters appear as 0.4 m circles with a heading tick, id, and expression label. Interactive props carry state labels. It is a permanent viewer feature on watch, replay, and play, so a student chasing a villager that keeps snagging on a wall sees the art and the collision truth in one frame.

On the visitor seat, pointer and keyboard input compose the locomotion, and an expression palette offers the emotes and use, with the prop a use would select highlighted as an informational preview that sends nothing. The 250 millisecond cadence is the human input window; there is no separate move clock. Speech is one text field in the host page's chat panel: type a line and everyone within hearing range gets it. Spectators and replay viewers receive no input.

## Platform metadata

| Entry | Value |
| --- | --- |
| Environment id | three_branches |
| Display name | Days at Three Branches |
| Description | A seeded village day in which separately running NPCs make one village feel alive around a human-played visitor. |
| Layout | seat plans cast_5 and cast_10 |
| Builtin agents, in order | naive (Naive), scripted_visitor (Scripted visitor) |
| Gameplay parameters | the declarations in Gameplay parameters, with friendly titles and descriptions; seat_plan is synthesized from the layout |
| Human-capable players | player_0, the visitor in every plan |
| Stepping | simultaneous |
| Pace interval | 250 milliseconds |
| Viewing cadence | 250 milliseconds per recorded transition |
| Live playout cadence | none; the game is simultaneous |
| Recommended episode ticks | 1200 (`META.recommended_episode_ticks`) |
| Compute limits | 0.25 seconds per decision, 120 seconds per game |
| Messaging | available; text limit 200 code points |
| LLM API | available; off by default, enabled by Seasons 5 and 6 |
| Seat order | does not change the game |
| Forfeit floor | 0 |
| Renderer | three-branches-village |

naive is the platform baseline required on every board. Compute limits are environment defaults a season may override; time an agent spends waiting on verified LLM proxy calls is not charged against them, and the template's background-request helper carries Season 5 dialogue across ticks.

The pace interval is a floor, not a promise. The harness collects every `act` call sequentially on one thread inside a simultaneous tick, per [execution.md](../../docs/specs/execution.md), so a tick costs the sum of its cast's decision times. A cast_10 day holds the 250 millisecond cadence, and finishes in about five real minutes, only while all eleven decisions together fit inside that window. A cast that spends its full per-decision budget stretches the day well past that, and the human playing the visitor feels every stall. The budget is deliberately generous, so the plan measures the shipped example's real cost per tick rather than assuming it. Setup runs on the same one thread: agent resets are sequential too, so whatever the cast spends precomputing is dead time before the village starts moving, which is its own reason to keep the shipped example's graph build modest.

## Package and student materials

The platform implementation includes the environment factory, default action, overlay extractor, registry entry, renderer, canonical student guide, template layer, and at least one worked example. Its package declares `PUBLISHED_EXAMPLES` explicitly, even when the first implementation keeps every worked example internal.

The template's helper package is `sandbox.village`, in the shape Skirmish at Crane Reach set with `sandbox.crane`: small namespaces a student imports individually, every function taking the observation first, every function either a stateless reader or a pure builder. Nothing holds state between ticks, so there is no map object to construct, reset, or carry across episodes.

| Namespace | Provides |
| --- | --- |
| `action` | `EMOTES`, `walk(heading, speed, expression)`, `stand(heading, expression)`. Both wrap the heading into range and clamp the speed, and `expression` takes `"none"`, an emote name, or `"use"`, so one call is one whole order. |
| `me` | `character_id`, `position`, `heading`, `moved`, `expression`, `home`, and `rng(observation, session_seed)`. |
| `people` | `seen`, `nearby`, `visitor`, `roster`. |
| `props` | `all` (standing knowledge: every interactive prop's id, type, cell, and facing), `seen` (the ones whose state is currently perceived), `in_reach`, `usable`, and `TYPES` from `catalog.json`. |
| `layout` | `frame`, `cell_at`, `ground_at`, `walkable`, `can_step`, `line_of_sight`, `buildings`, `building`, `doorway`, `spawn`, and `SPEED_LIMITS`. |
| `geometry` | `distance`, `heading_to`, `wrap`, `in_cone`, and the character profile's ranges and body radius. |
| `day` | `tick`, `phase`, `bell_ringing`, `parameters`. |

`layout` keeps movement and perception apart, because the ruleset does. `line_of_sight` walks the ground grid and is blocked only by wall cells. `can_step` answers the static map: whether a straight step crosses impassable ground, a catalog prop shape, or the boundary, ignoring characters, whose pushing and sliding belong to the engine. `walkable` asks whether a body of the character radius stands clear at a point at all. Both read the same ground grid and catalog shapes the engine collides with, so a helper cannot describe a village the physics does not agree with.

No helper decides anything: none picks a destination, a companion, or a prop. There is deliberately no pathfinder, the rule `sandbox.crane` already states. What the package withholds is the search, not the map: `observation["village"]` is the whole layout as standing knowledge, and `walkable`, `can_step`, and `ground_at` are exactly the node test, the edge test, and the edge cost a route planner is built from. Routing between the village's places belongs to the Season 4 starter example, which keeps the package a description of the engine's physics rather than a strategy library.

`me.rng` seeds a `random.Random` from the session seed and the character id, giving each villager a stable stream of its own without touching the platform seed contract. Its pins are behavioral: the same pair always yields the same stream, different ids yield different streams, and a stream is stable across runs.

All helpers are pin-tested against their authoritative engine or data contract, including a pin that one Agent instance cannot mutate another's layout observation or the environment's internal snapshot. Environment tests cover rules, scripted seeded rollouts, both seat plans, replay determinism, the use selection rule, speech delivery and limits, and village.md's generation guarantees across parameters and seeds. Renderer tests cover direct replay seeks and every human control. Course materials point students to the published platform documentation rather than the internal Sandbox specifications.

## Conformance notes

- The environment passes PettingZoo's parallel_api_test and the platform's stricter parallel subset: after reset the active set exactly covers the resolved players in player order and stays constant until every player terminates on tick 1200, and every mapping a step accepts or returns exactly covers the active players.
- `observation_space.contains()` holds for every observation across a full episode. Sequence fields are emitted as tuples, every Dict carries exactly its declared keys, and Text fields stay within the declared charset.
- Spaces are built once from the resolved parameters and never change within an episode. The default action is contained in the action space and legal in every reachable state; no action mask is published because none is needed.
- Overlay values are finite and JSON-safe, and recorded actions and messages normalize to plain JSON values.
- The design assumes mask-free `Dict` actions in simultaneous environments, environment-limited broadcasts, the live watcher visibility rule, and the live-session lifetime rules. Their rationale and implementation boundary are in [Platform contract expansions](stages/1-platform-expansions.md).
