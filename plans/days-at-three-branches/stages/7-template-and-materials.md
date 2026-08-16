# Step 7: Template, helpers, guide, and the worked example

Status: complete.

Part of [the plan](../README.md). This build-order step completes the student surface. It begins after step 4's generator and finishes after step 6. Using only the published guide, a student must be able to compose the template, run its pins, and play a local day with their villagers and the scripted visitor.

## What to build

### Helper package

Implement the [`sandbox.village` contract](../environment.md#package-and-student-materials) in `template/sandbox/village/`. Keep its seven independently imported namespaces: `action`, `me`, `people`, `props`, `layout`, `geometry`, and `day`.

| Area | Implementation responsibility |
| --- | --- |
| `action` | Build complete, in-space orders and validate expressions. |
| `me`, `people`, `props`, `day` | Read the current observation, including standing knowledge and perception. |
| `layout`, `geometry` | Read static village facts and provide pure movement, sight, and geometry calculations. |

Observation readers and static-map queries take observation first. `action.walk`, `action.stand`, the geometry functions, and the two player-id predicates are pure and take no observation. Student code, chat records, and documentation use `player_0` for the visitor and `player_1` upward for NPCs. Messaging uses the shared raw chat dictionaries without an environment-specific helper or id translation.

The complete public surface is:

- `action`: `EMOTES`, `walk(heading, speed=1.0, expression="none")`, and `stand(heading, expression="none")`.
- `me`: `player_id`, `position`, `heading`, `moved`, `expression`, `home`, and `rng(observation, session_seed)`.
- `people`: `seen`, `nearby`, `roster`, `is_visitor(player_id)`, and `is_npc(player_id)`.
- `props`: `TYPES`, `all`, `seen`, `in_reach`, and `usable`.
- `layout`: `SPEED_LIMITS`, `frame`, `cell_at`, `ground_at`, `walkable`, `can_step`, `line_of_sight`, `buildings`, `building`, `doorway`, and `spawn`.
- `geometry`: `BODY_RADIUS`, `VISION_RANGE`, `VISION_DEGREES`, `HEARING_RANGE`, `PROP_REACH`, `distance`, `heading_to`, `wrap`, and `in_cone`.
- `day`: `tick`, `phase`, `bell_ringing`, and `parameters`.

Provide no map object, module-global layout, controller decision, character/player conversion, or pathfinder. Private immutable normalization may be cached by immutable layout content, but observations and public mutable results never cross observation boundaries. `observation["village"]` provides the full map, while `walkable`, `can_step`, and `ground_at` let students build their own route graph. Build route graphs in `reset(seed, observation)`, where the layout is available before tick one and the cost counts toward the episode budget. Step 8 supplies one worked routing approach.

`me.rng(observation, session_seed)` returns a player-specific `random.Random` stream derived by a stable hash of session seed and player id. `people.is_visitor` accepts only `player_0`; `people.is_npc` accepts only canonical positive ids matching `player_[1-9][0-9]*`. These predicates classify syntax rather than roster membership.

### Template and guide

Make `template/agent.py` intentionally weak. It demonstrates walk, stand, wave, and use through the helpers. It uses a bench only when `props.usable` selects one, heads for its own doorway while on interior ground, and heads for the first pump afterward. It stores no memory or route; a wall can stop it.

Write `template/README.md` using the existing [Skirmish at Crane Reach template README](../../../environments/skirmish_crane/template/README.md) pattern. The canonical `environments/three_branches/environment.md` follows [docs/AGENTS.md](../../../docs/AGENTS.md) and uses this order:

1. Start with the template.
2. Make an action.
3. Explain the starter agent and its first improvement.
4. Explain match flow, seats and villagers, and the village's ground and props.
5. Explain scoring, helpers, season settings, time limits, and messaging.
6. Put action ids and the full observation fields in a raw-reference appendix, where `Discrete(11)` first appears.

Give these silent-failure rules worked passages: use requires speed 0 and `props.usable` previews selection; raw broadcast and direct chat both require hearing range and an unblocked line; speech sent on T first informs an action on T+2; and `nearby` is presence only, while lines arrive through the inbox. [The environment speech contract](../environment.md#speech) is authoritative.

### Worked example and CI

Ship internal Season 1 example `sweeper` in the `marcher` and `vanguard` layout: `README.md`, `agent.py`, and `tests/test_sweeper.py`. Derive a catalog role and one of four village quarters from the first two `me.rng` draws. Midpoint cells belong east or north. Choose the first matching prop in layout order inside the quarter, then the first global match, otherwise stand. Use the target when it is the selected usable prop. Otherwise choose a valid north, east, south, or west neighbor that minimizes distance to the target, using that order to break ties, and walk toward its center while sweeping. This is a greedy local policy, not a pathfinder. Keep `PUBLISHED_EXAMPLES` empty.

Add `("three_branches", "sweeper")` to `scripts/tests/test_compose.py`'s example inventory and add `sandbox/village/` to `scripts/_envs.py`'s pyright set.

## Tests

- Reader pins compare every `me`, `people`, `props`, and `day` accessor with real observations. Action pins require in-space `walk` and `stand` orders and reject unknown expressions.
- Layout pins compare `ground_at`, `walkable`, `can_step`, and `line_of_sight` with the engine grid, catalog shapes, and sight rules across pinned seeds. They cover water and wall clearance, prop and scenery shapes, the boundary, and wall-only sight blocking.
- Use pins match `props.usable` with `env.step` across reach, ties, stillness, and blocked lines. Pin `props.TYPES` to `catalog.json` and geometry constants to `rules.json`.
- Messaging pins use raw player ids and cover broadcasts, exact direct addressees, hearing and wall eligibility, and T/T+1/T+2 delivery timing without an id translation layer.
- Isolation pins confirm independent plain observation mappings across Agent instances and episodes, protect the engine snapshot from mutation, and require reset to leave no student-managed state.
- RNG pins cover stable same-seed-and-id streams, differing ids, and repeatable runs. Import-lightness pins exclude the engine and third-party dependencies.
- A reset-built whole-village graph pin uses `walkable` and `can_step`, leaves ample full-day episode budget, and reports reset and per-tick costs separately.
- `template/tests/test_episode.py` follows the spades pattern and is inherited by composed examples.
- The composed template and `sweeper` complete healthy days on both plans within per-decision and per-game budgets. Report cast_10 seconds per tick against the 250 millisecond cadence.
- Docs CI publishes the copied canonical guide. Examples CI runs on composed output, pins empty `PUBLISHED_EXAMPLES`, and smoke-tests the composed template and `sweeper` with inherited tests.

## Done when

A student-shaped reader composes the template, runs green pins, watches a local day with `python -m sandbox watch`, and plays the visitor beside their villagers using only the published guide. The guide matches shipped behavior, and the pins and budgets hold.
