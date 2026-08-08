# Step 2: Simulation engine and PettingZoo environment

Status: planned.

Part of [the plan](../README.md). This is build-order step 2: the whole [ruleset](../ruleset.md) as pure Python, wrapped in the PettingZoo environment with its metadata and both builtins. It runs on a small hand-authored fixture village until step 4 brings the real generator. The hands-on surface is full cast_3 and cast_10 days through the harness, recorded to JSONL inside the size budget and replaying identically.

## Why this is its own seam

The engine is the physics everything else trusts, and the environment is the platform face that the harness, recorder, backend, and web app consume. Building them together against a fixture village gets the full vertical slice running early, and step 7's template helpers are pin-tested against this engine rather than a second implementation of the rules.

## What to build

### The shared data files

`environments/three_branches/props.json` holds the prop catalog: for each type, its token, activity, states, start state, transition rule and count, footprint, instance count, and placement district. `environments/three_branches/rules.json` holds the constants both ends draw on: the emote list in action-id order, the ground classes with their speed limits, the character profile ranges, the phase table, and the day length. A small Python loader validates both files at import, the way Skirmish at Crane Reach loads `tile_types.json`, and the renderer imports the same files in step 3. Rule changes become data edits, not parallel code edits on two sides.

### Layout types and the fixture village

The static layout structure, shaped like the observation's `village` Dict: channels, road, and footpaths as centerline-and-width polylines, bridges, field and reed polygons, buildings with solid wall geometry and doorway gaps, props with footprints and rotations, scenery, and the spawn point. Step 4 fills it procedurally; this step ships one hand-authored fixture village, small but complete enough to exercise every rule: water with a bridge, each ground class, buildings with doorways, reeds, and props of every transition kind.

### The tick cycle

Character state (position, heading, speed, expression) and simultaneous resolution in character-id order, npc_0 upward and the visitor last. That order is not player order: the visitor is `player_0`, and the NPCs occupy `player_1` upward in NPC-id order. The engine works in character ids and the environment owns the mapping. Movement advances up to the commanded speed along the heading and stops at first contact with anything solid as already updated this tick, water and the boundary are impassable, and the speed limit comes from the ground class under the pre-tick position.

### Prop use and perception

Prop selection per the ruleset: the nearest prop within reach inside the vision cone with an unblocked line, judged on the pre-tick pose, ties broken by canonical prop order, stillness required, same-tick contention to the first in resolution order, hold and release semantics, and the three transition kinds driven by `props.json`. Perception: the vision cone and range, walls blocking sight, presence, and speech while doorways carry them, hearing range, reed same-bank concealment, prop visibility under the same rules, and the bell perceived everywhere while ringing. The day phases when daynight is on, and command degradation: a heading of 360 wraps to 0, an unavailable expression resolves to none, and the default is stand still with heading unchanged.

### Environment and spaces

The parallel environment on the engine, with the action and observation spaces from the [environment specification](../environment.md). Both seat plans, with the visitor as `player_0`: seat_0, the cast, holds `player_1` upward, and seat_1, the visitor, holds `player_0` and is restricted to `scripted_visitor`. Both gameplay parameters, and the six season presets pinned by test. Rewards are 0 every tick and 100 to every player on tick 1200, termination not truncation, no `result_scores` hook. `default_action` returns the player's current heading, speed 0, action 0.

### Speech

The chat policy lists each sender's talk recipients nearest first with the nearest as default, once per recipient per tick. NPC broadcasts bound to shout range and the visitor's to talk range through the step 1 hook. `public_messages` is on and the cap is 200 code points. Delivery timing needs no work: the harness already collects actions before chat hooks, so a line recorded on tick T reaches inboxes during T+1 after actions are chosen, and the earliest reaction is tick T+2, as the ruleset states.

### The compact overlay

Self-contained per the design, kept small the way Skirmish at Crane Reach keeps its overlay small: a versioned packed encoding with quantized coordinates and a `decode_overlay` authority, so the repeated static layout costs a few KB per frame and a full cast_10 day stays inside a 10 MiB recording budget, measured by test here and re-measured on the generated village in step 4. The layout section includes packed ground-grid rows sampled from the engine's ground classifier, which step 3's tile renderer consumes directly.

### Metadata and the builtins

`META` per the design's platform metadata table, including `recommended_episode_ticks=1200`, `human_players` as the single entry `player_0`, and the renderer key `three-branches-village`. The `naive` builtin plays the default action, the platform baseline. The `scripted_visitor` builtin wanders by road and path, approaches NPCs it sees, and offers a few canned lines, drawing randomness only from the session seed passed to `reset(seed)`. Registration surfaces: the package directory picked up by `npm run sync:envs`, the Docker image smoke-test line, the two builtin agent directories, and the forfeit floor entry in the backend's score module.

## Tests

- Unit tests per rule table and edge: contact stopping, ground limits, selection ties, stillness, transitions including timed reverts, hold and retoggle, cone, line, hearing, reed, and bell edges, phases, and resolution-order effects.
- The `props.json` and `rules.json` loaders reject malformed catalogs and pin the shipped values against the ruleset's tables.
- Shared conformance: `parallel_api_test`, the platform's stricter parallel subset, observation containment across a full episode, spaces built once.
- Seeded scripted rollouts on both plans, and replay determinism through the harness.
- Speech delivery timing, ranges, recipient policy, and the cap.
- Use selection through `env.step`, including contention and the stillness rule.
- The preset table pinned, and the recording size budget on a full cast_10 day.
- One cast member's crash forfeits the whole cast seat at floor 0.
- A full day fits the per-decision and per-game compute budgets.

## Done when

Full cast_3 and cast_10 days run through the harness on the fixture village, record inside budget, and replay identically, and the conformance suite is green for three_branches defaults.
