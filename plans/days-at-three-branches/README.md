# Days at Three Branches: Implementation Plan

Status: planned.

## Goal

Ship Days at Three Branches as a complete Game Sandbox environment: a student clones the template, builds a villager program against the published guide, watches days and plays the visitor in the browser, and competes across the six-season believability arc, where the human-rating board is the real leaderboard and the automated board is a health check. `naive` and `scripted_visitor` are the shipped builtins.

## Scope

Build everything the [environment specification](environment.md) calls the platform implementation: the village generator for [village.md](village.md), the simulation engine for the [ruleset](ruleset.md), the PettingZoo environment with its metadata, presets, and both builtins, the `three-branches-village` renderer, human visitor play, the template layer with the physics helpers, the canonical student guide, and the two worked examples. Step 1 contains every platform prerequisite this environment needs, including its first simultaneous mask-free `Dict` action space.

Five decisions bind the whole plan:

- The map is a grid, and it has two layers. Characters move continuously in metres, while the static map is a grid of square cells whose class carries the cell's speed, its passability, and whether it blocks sight. Water, building walls, doorways, and building floors are all ground, so the whole of a building's geometry is one indexed lookup and walls are the only thing that blocks a line. Interactive props and scenery stand on that grid as the second layer, reserving cells and carrying their own catalog box or circle collision shape, so a well pump is round and a bench is square. pymunk resolves movement over both.
- There is one character order, and the platform's player numbering is that order. The visitor is character 0 and `player_0`; `npc_i` is character i+1 and `player_(i+1)`. Roster order, prop contention, and conformance all read it, so the visitor leads contention and a human never loses a bench race to the cast. seat_0 holds the cast from `player_1` upward, seat_1 holds the visitor, and `human_players` is the single entry `player_0`.
- Player ids stay inside the environment. Observations, helpers, and student documents speak character ids alone, `npc_0` through `npc_9` and `visitor`, so a student learns one vocabulary and never meets a second numbering.
- Shared game data lives in `rules.json` (the village frame, ground classes, emote order, character profile, phases, day length) and `catalog.json` (the building, interactive-prop, and scenery types). [ruleset.md](ruleset.md) is the canonical human-readable catalog. The Python engine and TypeScript renderer read both files without enumerating supported types. A data-only type works when it reuses an existing transition, placement, and art mechanism. Generator tuning lives in `generation.json` and visual tuning in the renderer's `presentation.json`, so calibrating the look can never move a building.
- The recording is plain JSON. Its header carries the whole static village once, in the same shape the observation's `village` field takes, and each recorded state carries only what moves: the tick, the phase, every character's pose and expression, and every interactive prop's state. One shape serves students, helpers, and the renderer.

The renderer ships one rendering path plus a permanent viewer-toggleable collision overlay, so the art and the collision truth read in the same frame.

Non-goals, recorded so they stay deliberate:

- Two worked examples, both kept internal. `PUBLISHED_EXAMPLES` stays empty, as it does for Skirmish at Crane Reach.
- The scripted visitor speaks canned lines only. No LLM visitor.
- Course materials beyond the canonical guide are pedagogy work, not platform work.

## Spec references

[ruleset.md](ruleset.md), [village.md](village.md), [environment.md](environment.md), [pedagogy.md](pedagogy.md), [worldview.md](worldview.md), and on the platform side [environment.md](../../docs/specs/environment.md), [communication.md](../../docs/specs/communication.md), [interaction.md](../../docs/specs/interaction.md), [recording.md](../../docs/specs/recording.md), [seasons.md](../../docs/specs/seasons.md), [llm.md](../../docs/specs/llm.md), [submission.md](../../docs/specs/submission.md), [leaderboard.md](../../docs/specs/leaderboard.md), [execution.md](../../docs/specs/execution.md).

## Depends on

The completed platform stages provide named builtins and restricted seats (16), simultaneous stepping (17), the canonical zod contract (18), composite action spaces (19), and the LLM gateway's proxy, credentials, and budgets. Step 1 contains the remaining platform prerequisites. The simultaneous paths exist end to end but have never carried a production environment; steps 2 and 3 exercise them for real. Nothing here blocks on skirmish-crane, which continues in parallel.

## Build order

Each step is its own subplan under [stages/](stages/) and ends with something you can put hands on. Steps 1 through 4 form a chain: step 2 registers a minimal real stub alongside the engine and fixture village, step 3 replaces it with the browser renderer and watch surface, and step 4 replaces the fixture with the generator. Generation is then iterated visually in the real viewer. Step 5.1 follows 4; 5.2 follows 5.1 and specifies step 6's input UI before step 6 builds it. Step 7 can begin after step 4 and finishes after step 6. Step 8 closes the plan.

Cast size and the day are fixed everywhere: `cast_5` for Season 1, `cast_10` from Season 2 on, a village of five homes for both, and 1200 ticks at a 250 millisecond cadence, which is about five real minutes for a full day.

1. **[Platform contract expansions](stages/1-platform-expansions.md).** Mask-free `Dict` actions in simultaneous environments, environment-limited broadcasts, the live watcher visibility rule, the setup observation on `reset`, and live-session lifetime rules, landed as one platform change proven by a fixture environment. Hands-on: the fixture passes the full conformance suite with bounded broadcasts, public delivery, and an agent precomputing from its setup observation, all visible in tests.
2. **[Simulation engine and PettingZoo environment](stages/2-engine-and-environment.md).** The whole ruleset as a Python engine over the cell grid, movement resolved by pymunk, with the platform face on top: spaces, seat plans, presets, the broadcast hook, the recording overlay, `naive`, and `scripted_visitor`, running on a fixture village, with shared `rules.json` and `catalog.json`. It registers the minimal real stub the following stages extend. Hands-on: full cast_5 and cast_10 days record to JSONL inside the size budget and replay identically.
3. **[Renderer, collision overlay, watch and replay](stages/3-renderer-and-registration.md).** The village on the shared tiled-ground base, extended to a layer stack, under a placeholder tileset, the permanent collision overlay above it, the fitted, pannable, zoomable village on the shared camera, and the e2e group. It replaces the stage 2 stub with the real renderer and watch surface. Hands-on: watch a live match in the browser, scrub its replay to exact frames, and run a local watch-mode day.
4. **[Village generator](stages/4-village-generator.md).** The seeded village under village.md's guarantees, carved and pathfound over the grid in two owner-reviewed halves (the land and its routes, then the settlement and its dressing) behind the same contract, with fixture padding keeping the first half watchable in the browser. Hands-on: each half reviewed in local watch sessions until signed off, ending with the guarantee suite green across a pinned seed batch.
5. **Realistic rendering, in two signed parts:** [5.1 art style](stages/5-1-art-style.md), the village's visual identity over the same tiled pipeline, prop animations, and phase lighting; [5.2 HUD and interaction design](stages/5-2-hud-interaction-and-camera.md), the information layer, the step 6 input specification, and the tuned zoom limits. Each merges on the owner's sign-off. Hands-on: the pinned fixture replays in the final style and can be explored close up.
6. **[Human play](stages/6-human-play.md).** Pointer and keyboard locomotion, the expression palette with its use preview, chat, and local parity. Hands-on: play the visitor live in the browser against a running cast, and locally.
7. **[Template, helpers, guide, and the worked example](stages/7-template-and-materials.md).** The complete student surface: the `sandbox.village` helper package, the starter agent, the canonical guide, and `sweeper`, pin-tested against the engine. Hands-on: the full student flow from clone to a local day beside the scripted visitor.
8. **[Starter village routines and the dialogue example](stages/8-starter-village-routines.md).** The closing delivery, shipped before Season 4: `neighbor`, carrying the routine library with its routing and the dialogue layer that answers the visitor in character.

## Done when

A student can clone the composed template, run the helper pin tests, and run a local day with their villagers beside the scripted visitor. A viewer can watch a live day to its natural end, scrub the replay to exact frames, and toggle the collision overlay over any of it. A human can play the visitor with pointer and keyboard locomotion, the expression palette with its use preview, and chat. cast_5 and cast_10 days record inside the platform's 10 MiB budget and replay identically, every client sees every spoken line, the shared conformance suite covers three_branches defaults, the six season presets are pinned by test, and the platform specification names Days at Three Branches as its shipped simultaneous, mask-free `Dict` environment.

## Later work

- Publishing `neighbor` when Season 4 opens, and any further worked examples.
- Season 5 and 6 course operations (budget advice, rating prompts) as course material, not platform work.
