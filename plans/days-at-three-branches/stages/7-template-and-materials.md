# Step 7: Template, helpers, guide, and the worked example

Status: planned.

Part of [the plan](../README.md). This build-order step completes the student surface. It begins after step 4's generator and finishes after step 6. Using only the published guide, a student must be able to compose the template, run its pins, and play a local day with their villagers and the scripted visitor.

## What to build

### Helper package

Implement the [`sandbox.village` contract](../environment.md#package-and-student-materials) in `template/sandbox/village/`. Keep its eight independently imported namespaces, `action`, `me`, `people`, `props`, `layout`, `geometry`, `day`, and `speech`.

| Area | Implementation responsibility |
| --- | --- |
| `action` | Build complete, in-space orders and validate expressions. |
| `me`, `people`, `props`, `day` | Read the current observation, including standing knowledge and perception. |
| `layout`, `geometry` | Read static village facts and provide pure movement, sight, and geometry calculations. |
| `speech` | Build broadcasts and direct lines from character ids, and translate inbox player ids to character ids. |

Except for `speech`, every helper takes observation first and is a stateless reader or pure builder. `speech.broadcast(text)`, `speech.to(character_id, text)`, and `speech.messages(inbox)` are pure and take no observation. They translate the environment's internal player ids. Student code and documentation use only `visitor` and `npc_0` through `npc_9`.

Provide no map object, module-global layout, controller decision, or pathfinder. Invisible caching may be keyed by layout content. `observation["village"]` provides the full map, while `walkable`, `can_step`, and `ground_at` let students build their own route graph. Build route graphs in `reset(seed, observation)`, where the layout is available before tick one and the cost counts toward the episode budget. Step 8 supplies one worked routing approach.

`me.rng(observation, session_seed)` returns a character-specific `random.Random` stream derived from session seed and character id.

### Template and guide

Make `template/agent.py` intentionally weak. It demonstrates walk, stand, an emote, and use through the helpers. It heads for its doorway while home and the well plaza afterward, waves at a villager in sight, and sits at a bench in reach. It stores no memory or route; a wall can stop it.

Write `template/README.md` using the existing [Skirmish at Crane Reach template README](../../../environments/skirmish_crane/template/README.md) pattern. The canonical `environments/three_branches/environment.md` follows [docs/AGENTS.md](../../../docs/AGENTS.md) and uses this order:

1. Start with the template.
2. Make an action.
3. Explain the starter agent and its first improvement.
4. Explain match flow, seats and villagers, and the village's ground and props.
5. Explain scoring, helpers, season settings, time limits, and messaging.
6. Put action ids and the full observation fields in a raw-reference appendix, where `Discrete(11)` first appears.

Give these silent-failure rules worked passages: use requires speed 0 and `props.usable` previews selection; `speech.broadcast(text)` and `speech.to(character_id, text)` both require hearing range and an unblocked line; speech sent on T first informs an action on T+2; and `nearby` is presence only, while lines arrive through the inbox. [The environment speech contract](../environment.md#speech) is authoritative.

### Worked example and CI

Ship internal Season 1 example `sweeper` in the `marcher` and `vanguard` layout: `README.md`, `agent.py`, and `tests/test_sweeper.py`. Derive a role with `me.rng`, wander its village quarter, idle, and loop on a role-owned prop. A one-minute viewer should be able to tell what each villager is doing. Keep `PUBLISHED_EXAMPLES` empty.

Add `("three_branches", "sweeper")` to `scripts/tests/test_compose.py`'s example inventory and add `sandbox/village/` to `scripts/_envs.py`'s pyright set.

## Tests

- Reader pins compare every `me`, `people`, `props`, and `day` accessor with real observations. Action pins require in-space `walk` and `stand` orders and reject unknown expressions.
- Layout pins compare `ground_at`, `walkable`, `can_step`, and `line_of_sight` with the engine grid, catalog shapes, and sight rules across pinned seeds. They cover water and wall clearance, prop and scenery shapes, the boundary, and wall-only sight blocking.
- Use pins match `props.usable` with `env.step` across reach, ties, stillness, and blocked lines. Pin `props.TYPES` to `catalog.json` and geometry constants to `rules.json`.
- Speech pins cover pure `broadcast`, `to`, and `messages` helpers, character-id to player-id translation in both directions, broadcasts, direct addressees, hearing and wall eligibility, and T/T+1/T+2 delivery timing.
- Isolation pins confirm independent plain observation mappings across Agent instances and episodes, protect the engine snapshot from mutation, and require reset to leave no student-managed state.
- RNG pins cover stable same-seed-and-id streams, differing ids, and repeatable runs. Import-lightness pins exclude the engine and third-party dependencies.
- A reset-built whole-village graph pin uses `walkable` and `can_step`, leaves ample full-day episode budget, and reports reset and per-tick costs separately.
- `template/tests/test_episode.py` follows the spades pattern and is inherited by composed examples.
- The composed template and `sweeper` complete healthy days on both plans within per-decision and per-game budgets. Report cast_10 seconds per tick against the 250 millisecond cadence.
- Docs CI publishes the copied canonical guide. Examples CI runs on composed output, pins empty `PUBLISHED_EXAMPLES`, and smoke-tests the composed template and `sweeper` with inherited tests.

## Done when

A student-shaped reader composes the template, runs green pins, watches a local day with `python -m sandbox watch`, and plays the visitor beside their villagers using only the published guide. The guide matches shipped behavior, and the pins and budgets hold.
