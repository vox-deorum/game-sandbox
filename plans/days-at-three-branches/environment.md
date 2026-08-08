# Days at Three Branches: PettingZoo Environment

This document defines how the [ruleset](ruleset.md) appears through the platform's PettingZoo interface: seats and players, gameplay parameters, the tick cycle, the action and observation spaces, scoring, speech, and rendering. It is an internal design document for the environment implementation, written against the [platform environment contract](../../docs/specs/environment.md). The ruleset stays the source of game truth and [village.md](village.md) the source of place; this document only fixes the representation. It assumes the contract expansions listed in the conformance notes.

## Seats and players

The environment declares seat plans. seat_0 is the cast and seat_1 is the visitor in every plan. The visitor is `player_0`. The NPCs use `player_1` upward in NPC-id order.

| Plan    | Title           | Players |
| ------- | --------------- | ------- |
| cast_3  | Three villagers | 4       |
| cast_10 | Ten villagers   | 11      |

| Plan    | Seat                | Ordered players            |
| ------- | ------------------- | -------------------------- |
| cast_3  | seat_0, the cast    | player_1 through player_3  |
| cast_3  | seat_1, the visitor | player_0                   |
| cast_10 | seat_0, the cast    | player_1 through player_10 |
| cast_10 | seat_1, the visitor | player_0                   |

cast_3 is declared first and is the default. PettingZoo player order is player_0, then player_1 upward, with the visitor first. It controls the order of `possible_agents`, active-player mappings, and platform conformance. The ruleset resolution order is different: npc_0 upward, then the visitor. It controls same-tick action resolution and the cast roster. Every roster entry carries both its PettingZoo player id and ruleset character id, so agents never recompute the mapping.

The cast seat takes one submission, and every NPC runs a separately constructed instance of it, differentiated only by the id it reads from its observation. The visitor seat is restricted to the scripted_visitor builtin and its player is human-capable: a human plays the visitor in live sessions, and the builtin plays it in automated runs. Two builtins are declared: naive (Naive), the platform baseline that fills the cast seat in automated schedules, and scripted_visitor (Scripted visitor), which wanders the village, approaches NPCs, and offers a few canned lines. Seat order does not change the game, since the plans hold one unrestricted seat.

## Gameplay parameters

| Name | Friendly title | Type | Default | Bounds or choices | Description |
| --- | --- | --- | --- | --- | --- |
| seat_plan | Cast size | choice (reserved) | cast_3 | cast_3 (Three villagers), cast_10 (Ten villagers) | Selects the declared seat plan and cast size. |
| daynight | Day and night | bool | false |  | Enables the ruleset's day phases. |

The village always holds the same 33 props and the day is fixed at 1200 ticks, so there are no density or length parameters.

Defaults reproduce Season 1. The season schedule resolves to:

| Season | seat_plan | daynight | LLM API |
| ------ | --------- | -------- | ------- |
| 1      | cast_3    | false    | off     |
| 2      | cast_10   | false    | off     |
| 3      | cast_10   | false    | off     |
| 4      | cast_10   | true     | off     |
| 5      | cast_10   | true     | on      |
| 6      | cast_10   | true     | on      |

Each row ships as a declared `META.presets` entry, choosable in the web dialogs and with `--preset season_1` through `--preset season_6`. Tests pin the table. Messaging is on in every season, and LLM API availability is platform metadata a season toggles, not a gameplay parameter. Seasons 2 and 3 resolve identically, as do 5 and 6: what those seasons change lives in pedagogy and season configuration rather than in parameters.

## Match flow

`reset(seed)` uses the session seed for village generation. The environment draws no randomness after generation. Every agent receives the same session seed through `reset(seed)`. The scripted visitor uses it directly. A cast agent can combine it with the character id from its first observation through the template's `character_seed(session_seed, character_id)` helper when it wants an NPC-specific random stream. Characters start in the ruleset's initial pose (each NPC at its home center facing its doorway, the visitor at the road spawn facing into the village, everyone still with expression none), and every prop starts unheld in its start state. The same seed and action sequence replay identically, per the ruleset's determinism rule.

The environment is simultaneous: one ruleset tick is one parallel `env.step()` with a complete PettingZoo-player-keyed action map. Every character selects from the same pre-tick state, and the engine resolves all actions together in ruleset resolution order. Within a tick the harness collects every action first and runs chat hooks after, so speech follows action selection, as the speech section describes.

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

A use acts on the nearest prop, position to position, among the props within the ruleset's reach that lie inside the user's vision cone with an unblocked line; ties break by canonical prop order. Selection is judged on the pre-tick pose, the same state the observation shows, and a use needs commanded speed 0, per the ruleset, so the template's `usable_prop` helper and the renderer preview are exact. The agent never names a prop, so the space carries no prop dimension. After selection the ruleset's availability rules apply: no qualifying prop resolves to none, a held prop resolves to none, and same-tick contention goes to the first character in ruleset resolution order.

Every value inside the space is legal in every state, because commanded values degrade rather than fail, per the ruleset; the environment therefore publishes no action mask. A value outside the space (a missing key, a wrong dtype, an out-of-bounds number) is rejected by `env.step()` as an illegal participant action, so degradation applies only inside the declared bounds. The environment entry's `default_action(env, player_id)` returns the player's current heading, speed 0, action 0: stand still, which is legal in every reachable state, is what the harness plays for a late or missing action, and is exactly the ruleset's default.

## Observations

The observation is a plain `Dict`: with no action mask there is no wrapper. Its schema is fixed by the resolved parameters at construction and stays constant for the whole episode. Positions everywhere are `{"x", "y"}` Dicts of `Box(0.0, 100.0, shape=(), float32)` meters, headings use the action convention, and speeds are meters per tick in `Box(0.0, 1.0)`.

| Field | Space | Content |
| --- | --- | --- |
| self | Dict | id, visitor, position, heading, speed, expression |
| seen | Sequence of Dicts | every other character in the vision cone with an unblocked line: id, visitor, position, heading, speed, expression |
| heard | Sequence of Dicts | every other character in hearing range with an unblocked line: id, position |
| props_seen | Sequence of Dicts | prop and state for every prop seen under the same cone and line rules |
| bell | Discrete(2) | 1 while the beacon bell rings, whatever the distance |
| tick | Discrete(1200, start=1) | the current tick |
| phase | Text | the day phase; the constant day when daynight is off |
| village | Dict | the static layout, generated at reset and constant |
| cast | Tuple of Dicts | NPCs from npc_0 upward, then the visitor: player, id, home, visitor |
| parameters | Dict | encoded values for both resolved gameplay parameters |

- An expression is `{"type", "target"}`: type is Text (none, an emote name, or use) and target is `Discrete(34)`, naming the prop in use counted from 1 and 0 otherwise.
- A character's visitor field is `Discrete(2)`, 1 for the visitor and 0 for an NPC: the ruleset's kind, carried as a flag. In cast, `home` is `Text(max_length=16)`: an NPC carries its home building id and the visitor carries the literal string `"none"`. Both values fit the declared space.
- props_seen entries are `{"prop": Discrete(33), "state": Text}`, indexing the village prop list. States use the ruleset's state words. Reed concealment and every other perception rule is applied by the environment, so these fields contain exactly what the ruleset lets the character perceive.
- village contains: channels (the trunk first, then the three branch channels), road, and footpaths as `{"points", "width"}` centerline Dicts, points a Sequence of positions; bridges as `{"position", "heading", "width", "span"}`, the span covering the channel plus both aprons; fields and reed_banks as Sequences of polygon vertex Sequences; buildings as `{"id", "type", "center", "width", "depth", "rotation", "doorway"}` with doorway `{"position", "width"}`, ids home_0 through home_9, inn, and shed. A doorway position is the center of its gap on the building perimeter. Each building rectangle is its placement footprint. Its wall geometry is the rectangle perimeter with the doorway gap removed, and its interior is walkable. Movement collision and line-of-sight tests derive the same wall segments from these fields. Props are `{"id", "type", "position", "footprint", "rotation"}`, footprint a `{"width", "depth"}` Dict in meters, in canonical order (village.md's table order by type, generation order within type), with the type tokens stall, lantern, bench, shrine, board, plot, hearth, repair_bench, pump, and bell, and ids the type token plus its index in canonical order, stall_0 upward; scenery is `{"type", "position", "radius"}` with the type tokens pine, crate, and post for the pines, crates, and shrine posts; and spawn is the visitor's spawn position. Water is the channel shapes, road-class ground is the road, bridge, and footpath shapes, field and reed ground are the polygons, and open ground is everything else walkable, so the layout carries the ruleset's full standing knowledge.
- Text fields use lowercase letters, digits, and underscore, minimum length 1: character ids are `Text(max_length=8)`, player `Text(max_length=9)`, prop and building ids `Text(max_length=16)`, prop types `Text(max_length=12)`, states `Text(max_length=9)`, phase `Text(max_length=7)`, expression type `Text(max_length=10)`.
- `parameters` contains `seat_plan` as `Text(max_length=7)` and `daynight` as `Discrete(2)`.
- tick names the tick the observation's action will play in: the reset observation carries tick 1, and the terminal observation of the final step keeps tick 1200.
- The inbox is not part of the observation; speech travels through the platform messaging layer.

## Rewards and scoring

Every nonterminal reward is 0. On the final tick every player, the visitor included, receives 100. The ruleset's health check is realized by the platform's forfeit rules rather than computed in the environment: a crash, an illegal action, or an exhausted episode compute budget by any cast member forfeits the whole cast seat at the forfeit floor 0, and a session that ends before the day does keeps its accumulated 0. A single late `act` is not a failure: the harness plays the default action and the day goes on. Every honest completed day scores 100, so the automated board orders by its compute-time tiebreak, which is the intended reading: believability is judged by people, per [pedagogy.md](pedagogy.md).

## Speech

The ruleset's speech maps onto the platform messaging layer, with loudness carried by the two message forms.

- A talk is a direct message. The environment's recipient policy lists, for each sender, the characters within talk range with an unblocked line, nearest first; the default recipient is the first listed, or broadcast when nobody is near. A sender may talk to each permitted recipient once per tick.
- A shout is a broadcast, and the environment limits its delivery: an NPC broadcast reaches every character within shout range with an unblocked line, and the visitor's broadcast reaches talk range, because visitor speech is talk.
- The environment declares its messages public: every delivered line appears in every client's state, renders as a speech bubble over the speaker, and shows in the chat panel, so viewers see every line, per the ruleset.
- A line recorded on tick T reaches its hearers' inboxes during tick T+1, after that tick's actions are chosen, so the first action that can react to a line is tick T+2's. A character keeps its inbox in its own memory between ticks.
- The text limit is 200 code points.

## Rendering and human input

The three-branches-village renderer draws from the semantic overlay and the state's admitted messages. The overlay is self-contained, so live play and a replay seek to the same state produce the same frame: it carries the layout, every character's position, heading, speed, and expression, every prop state, the bell, the tick, and the phase. Active prop states render as sustained animation, derived from the state alone: a lit lantern glows, the lit hearth burns, a tended shrine trails incense smoke, the flowing pump pours, and the ringing bell swings. There is no fog: every viewer, the human visitor included, sees the whole village, because the game is judged by watching it. Every live session emits the opening presentation state, so the village renders before the first tick.

On the visitor seat, pointer and keyboard input compose the locomotion, and an expression palette offers the emotes and use, with the prop a use would select highlighted as an informational preview that sends nothing. The 500 millisecond cadence is the human input window; there is no separate move clock. Speech uses the host page's chat panel, whose recipient choices follow the talk policy above. Spectators and replay viewers receive no input.

## Platform metadata

| Entry | Value |
| --- | --- |
| Environment id | three_branches |
| Display name | Days at Three Branches |
| Description | A seeded village day in which separately running NPCs make one village feel alive around a human-played visitor. |
| Layout | seat plans cast_3 and cast_10 |
| Builtin agents, in order | naive (Naive), scripted_visitor (Scripted visitor) |
| Gameplay parameters | the declarations in Gameplay parameters, with friendly titles and descriptions; seat_plan is synthesized from the layout |
| Human-capable players | player_0, the visitor in every plan |
| Stepping | simultaneous |
| Pace interval | 500 milliseconds; one tick is half a second of village time |
| Viewing cadence | 500 milliseconds per recorded transition |
| Live playout cadence | none; the game is simultaneous |
| Recommended episode ticks | 1200 (`META.recommended_episode_ticks`) |
| Compute limits | 0.25 seconds per decision, 120 seconds per game |
| Messaging | available; text limit 200 code points |
| LLM API | available; off by default, enabled by Seasons 5 and 6 |
| Seat order | does not change the game |
| Forfeit floor | 0 |
| Renderer | three-branches-village |

naive is the platform baseline required on every board. Compute limits are environment defaults a season may override; time an agent spends waiting on verified LLM proxy calls is not charged against them, and the template's background-request helper carries Season 5 dialogue across ticks.

## Package and student materials

The platform implementation includes the environment factory, default action, overlay extractor, registry entry, renderer, canonical student guide, template layer, and at least one worked example. Its package declares `PUBLISHED_EXAMPLES` explicitly, even when the first implementation keeps every worked example internal. The template exposes an episode-scoped `VillageMap` built from `observation["village"]`. Its geometry methods are `ground_at(position)`, `blocked(a, b)`, `walkable(position)`, and `path_to(a, b)`, all using the layout's derived wall segments. Standalone helpers provide `usable_prop(observation)`, `character_seed(session_seed, character_id)`, emote-name and action-id lookups, and locomotion builders. `character_seed` joins the session seed's canonical base-10 integer text, a colon, and the exact character id. It hashes those UTF-8 bytes with SHA-256 and reads the first eight digest bytes as an unsigned big-endian integer from 0 through 2^64 - 1. The locomotion builder wraps the heading into range and clamps the speed. All helpers are pin-tested against their authoritative engine or data contract. Environment tests cover rules, scripted seeded rollouts, both seat plans, replay determinism, the use selection rule, speech delivery and limits, and village.md's generation guarantees across parameters and seeds. Renderer tests cover direct replay seeks and every human control. Course materials point students to the published platform documentation rather than the internal Sandbox specifications.

## Conformance notes

- The environment passes PettingZoo's parallel_api_test and the platform's stricter parallel subset: after reset the active set exactly covers the resolved players in PettingZoo player order and stays constant until every player terminates on tick 1200, and every mapping a step accepts or returns exactly covers the active players.
- `observation_space.contains()` holds for every observation across a full episode. Sequence fields are emitted as tuples, every Dict carries exactly its declared keys, and Text fields stay within the declared charset.
- Spaces are built once from the resolved parameters and never change within an episode. The default action is contained in the action space and legal in every reachable state; no action mask is published because none is needed.
- Overlay values are finite and JSON-safe, and recorded actions and messages normalize to plain JSON values.
- The design assumes mask-free `Dict` actions in simultaneous environments, environment-limited broadcasts, public messages, and the live-session lifetime rules. Their rationale and implementation boundary are in [Platform contract expansions](stages/1-platform-expansions.md).
