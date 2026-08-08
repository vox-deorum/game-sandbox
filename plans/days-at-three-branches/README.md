# Days at Three Branches: Implementation Plan

Status: planned.

## Goal

Ship Days at Three Branches as a complete Game Sandbox environment: a student clones the template, builds a villager program against the published guide, watches days and plays the visitor in the browser, and competes across the six-season believability arc, where the human-rating board is the real leaderboard and the automated board is a health check. `naive` and `scripted_visitor` are the shipped builtins.

## Scope

Build everything the [environment specification](environment.md) calls the platform implementation: the village generator for [village.md](village.md), the simulation engine for the [ruleset](ruleset.md), the PettingZoo environment with its metadata, presets, and both builtins, the `three-branches-village` renderer, human visitor play, the template layer with the physics helpers, the canonical student guide, one worked example, and the Season 5 dialogue helper. Step 1 contains every platform prerequisite this environment needs, including its first simultaneous mask-free `Dict` action space.

Two decisions bind the whole plan:

- The visitor is `player_0` in every plan: seat_0, the cast, holds `player_1` upward, and seat_1, the visitor, holds `player_0`. `human_players` is the single entry `player_0`, which works for both plans.
- Game data that both ends need lives in shared JSON under the environment package: `props.json` (the prop catalog) and `rules.json` (emote order, ground speeds, character profile, phases, day length). The Python engine and the TypeScript renderer read the same files, the way Skirmish at Crane Reach shares `tile_types.json`.

The renderer ships two permanent viewer-selectable modes: a debug view at collision truth, and the realistic view built on it in owner-signed parts.

Non-goals, recorded so they stay deliberate:

- One worked example, kept internal. `PUBLISHED_EXAMPLES` stays empty.
- The scripted visitor speaks canned lines only. No LLM visitor.
- Course materials beyond the canonical guide are pedagogy work, not platform work.

## Spec references

[ruleset.md](ruleset.md), [village.md](village.md), [environment.md](environment.md), [pedagogy.md](pedagogy.md), [worldview.md](worldview.md), and on the platform side [environment.md](../../docs/specs/environment.md), [communication.md](../../docs/specs/communication.md), [interaction.md](../../docs/specs/interaction.md), [recording.md](../../docs/specs/recording.md), [seasons.md](../../docs/specs/seasons.md), [llm.md](../../docs/specs/llm.md), [submission.md](../../docs/specs/submission.md), [leaderboard.md](../../docs/specs/leaderboard.md), [execution.md](../../docs/specs/execution.md).

## Depends on

The completed platform stages provide named builtins and restricted seats (16), simultaneous stepping (17), the canonical zod contract (18), composite action spaces (19), and the LLM gateway's proxy, credentials, and budgets. Step 1 contains the remaining platform prerequisites. The simultaneous paths exist end to end but have never carried a production environment; steps 2 and 3 exercise them for real. Nothing here blocks on skirmish-crane, which continues in parallel.

## Build order

Each step is its own subplan under [stages/](stages/) and ends with something you can put hands on. Steps 1 through 4 form a chain: the engine and environment run on a hand-authored fixture village until the generator replaces it, so the full vertical slice is watchable in the browser before generation work starts, and generation is then iterated visually in the real viewer. Step 5.1 follows 4; 5.2 follows 5.1 and specifies step 6's input UI before step 6 builds it. Step 7 can begin after step 4 and finishes after step 6. Step 8 closes the plan.

1. **[Platform contract expansions](stages/1-platform-expansions.md).** Mask-free `Dict` actions in simultaneous environments, environment-limited broadcasts, public messages, and live-session lifetime rules, landed as one platform change proven by a fixture environment. Hands-on: the fixture passes the full conformance suite with bounded broadcasts and public delivery visible in tests.
2. **[Simulation engine and PettingZoo environment](stages/2-engine-and-environment.md).** The whole ruleset as pure Python with the platform face on top: spaces, seat plans, presets, chat policy, compact overlay, `naive`, and `scripted_visitor`, running on a fixture village, with the shared `props.json` and `rules.json`. Hands-on: full cast_3 and cast_10 days record to JSONL inside the size budget and replay identically.
3. **[Debug renderer, registration, watch and replay](stages/3-debug-renderer-and-registration.md).** The collision-truth view on a shared tiled-map base (pixi-tiledmap, common to all environments), the catalog entry, and the e2e group. Hands-on: watch a live match in the browser, scrub its replay to exact frames, and run a local watch-mode day.
4. **[Village generator](stages/4-village-generator.md).** The seeded layout under village.md's guarantees, replacing the fixture village behind the same contract. Hands-on: any seed's village explored in the browser debug view, with the guarantee suite green across a pinned seed batch.
5. **Realistic rendering, in two signed parts:** [5.1 art style](stages/5-1-art-style.md), the village's visual identity over the same tiled-map pipeline, prop animations, phase lighting, and the mode toggle; [5.2 HUD, interaction design, and camera](stages/5-2-hud-interaction-and-camera.md), the information layer, the step 6 input specification, and the fitted, pannable, zoomable village. Each merges on the owner's sign-off. Hands-on: the pinned fixture replays in the final style in both modes and can be explored close up.
6. **[Human play](stages/6-human-play.md).** Pointer and keyboard locomotion, the expression palette with its use preview, talk-policy chat, and local parity. Hands-on: play the visitor live in the browser against a running cast, and locally.
7. **[Template, helpers, guide, and the worked example](stages/7-template-and-materials.md).** The complete student surface, pin-tested against the engine. Hands-on: the full student flow from clone to a local day beside the scripted visitor.
8. **[Season 5 dialogue helper](stages/8-llm-dialogue-helper.md).** The closing delivery, shipped before Season 5, adds the background dialogue controller and its worked pattern.

## Done when

A student can clone the composed template, run the helper pin tests, and run a local day with their villagers beside the scripted visitor. A viewer can watch a live day to its natural end and scrub the replay to exact frames in both render modes. A human can play the visitor with pointer and keyboard locomotion, the expression palette with its use preview, and talk-policy chat. cast_3 and cast_10 days record inside the 10 MiB budget and replay identically, spectators see every spoken line, the shared conformance suite covers three_branches defaults, the six season presets are pinned by test, and the platform specification names Days at Three Branches as its shipped simultaneous, mask-free `Dict` environment.

## Later work

- Further worked examples and their publication timing.
- Season 5 and 6 course operations (budget advice, rating prompts) as course material, not platform work.
