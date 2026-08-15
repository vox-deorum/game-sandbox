# Days at Three Branches: Implementation Plan

Status: in progress. Steps 1, 2, 5.0, and 6 have shipped. Steps 3, 4, 5.1, 5.2, 7, and 8 remain.

## Goal

Ship Days at Three Branches as a complete Game Sandbox environment. A student clones the template, builds villagers from the published guide, watches a day, plays the visitor in the browser, and competes across a six-season believability arc. The human-rating board is the meaningful leaderboard; the automated board is a health check. The shipped builtins are `naive` and `scripted_visitor`.

## Contributor build path

Read the design contracts first: [rules](ruleset.md), [village](village.md), [environment interface](environment.md), [teaching arc](pedagogy.md), and [setting](worldview.md). Then follow the numbered [step plans](stages/) in dependency order. Step 1 landed the required platform support, including the first simultaneous mask-free `Dict` action space. Nothing here depends on Skirmish at Crane Reach, which has shipped.

Steps 1 through 4 form a chain. Step 2 registers a real stub with the engine and a fixture village. Step 3 replaces the stub with the browser renderer and watch surface, and step 4 replaces the fixture with the generator. Generation then iterates in the real viewer. Step 5.0 is independent infrastructure that lands before step 5.1. Step 5.1 follows step 4. Step 5.2 follows step 5.1 and defines the input UI before step 6 builds it. Step 7 can begin after step 4 and completes after step 6. Step 8 closes the plan.

The completed platform stages supply named builtins and restricted seats (16), simultaneous stepping (17), the canonical zod contract (18), composite action spaces (19), and the LLM gateway's proxy, credentials, and budgets. Steps 2 and 3 are the first production use of the simultaneous path.

## Scope

Build the platform work named in the [environment interface](environment.md): the [village generator](village.md), [simulation rules](ruleset.md), PettingZoo environment, metadata, presets, builtins, `three-branches-village` renderer, visitor play, template physics helpers, canonical student guide, and two worked examples.

The design contracts own the details:

- [Ruleset conventions](ruleset.md#conventions) define the map layers, character order, data files, timing, and game mechanics.
- [Environment seats and players](environment.md#seats-and-players), [observations](environment.md#observations), and [recording](environment.md#recording) define representation, player ids, and replay data.
- [Village generation](village.md#generation-order-and-guarantees) defines the seeded layout and guarantees.
- [Rendering and human input](environment.md#rendering-and-human-input) defines the collision overlay and visitor controls.

Non-goals:

- The two worked examples stay internal. `PUBLISHED_EXAMPLES` is empty.
- `scripted_visitor` uses canned speech only. There is no LLM visitor.
- Course materials beyond the canonical guide are pedagogy work, not platform work.

## Spec references

### Environment design

- [Ruleset](ruleset.md)
- [Village](village.md)
- [Environment interface](environment.md)
- [Pedagogy](pedagogy.md)
- [Worldview](worldview.md)

### Platform contracts

- [Environment](../../docs/specs/environment.md)
- [Communication](../../docs/specs/communication.md)
- [Interaction](../../docs/specs/interaction.md)
- [Recording](../../docs/specs/recording.md)
- [Seasons](../../docs/specs/seasons.md)
- [LLM](../../docs/specs/llm.md)
- [Submission](../../docs/specs/submission.md)
- [Leaderboard](../../docs/specs/leaderboard.md)
- [Execution](../../docs/specs/execution.md)

## Build order

Cast size and day length stay fixed throughout: `cast_5` in Season 1, `cast_10` from Season 2 onward, five homes in every village, and 1200 ticks at a 250 millisecond cadence, about five minutes for a full day.

1. **[Platform contract expansions](stages/1-platform-expansions.md).** Add mask-free `Dict` actions in simultaneous environments, bounded messaging, live watcher visibility, reset setup observations, and live-session lifetime rules. Outcome: a fixture passes conformance with bounded messaging, public delivery, and setup-observation precomputation.
2. **[Simulation engine and PettingZoo environment](stages/2-engine-and-environment.md).** Complete: the Python engine, physics, fixture village, spaces, seat plans, recording overlay, builtins, and registered temporary surface are in place. Fixed layouts and captured action streams replay identically.
3. **[Renderer, collision overlay, watch and replay](stages/3-renderer-and-registration.md).** Replace the stub with the tiled renderer, permanent collision overlay, camera, watch surface, replay, and e2e group. Outcome: live watch, exact replay scrubbing, and a local watch-mode day.
4. **[Village generator](stages/4-village-generator.md).** Generate the seeded village in two owner-reviewed halves, then validate the pinned seed batch. Outcome: a signed-off village and a green guarantee suite.
5. **Realistic rendering:** [5.0 atlas pipeline](stages/5-0-atlas.md) makes loose per-frame files the editable art truth and compiles them into the runtime atlases, independent infrastructure that can land at any time; [5.1 art style](stages/5-1-art-style.md) adds visual identity, prop animation, phase lighting, and an art-driven close-inspection zoom ceiling; [5.2 HUD and interaction design](stages/5-2-hud-interaction-and-camera.md) adds the information layer and input design, then may retune those camera limits against the final HUD. The two signed parts merge after owner sign-off. Outcome: the pinned fixture replays in final style and supports close exploration.
6. **[Human play](stages/6-human-play.md).** Add pointer and keyboard locomotion, expression preview and palette, chat, and local parity. Outcome: a person plays the visitor in the browser and locally.
7. **[Template, helpers, guide, and worked example](stages/7-template-and-materials.md).** Deliver `sandbox.village`, starter agent, canonical guide, and `sweeper`, pin-tested against the engine. Outcome: the full student flow from clone to a local day beside the scripted visitor.
8. **[Starter village routines and dialogue example](stages/8-starter-village-routines.md).** Deliver `neighbor`, the routine library, routing, and dialogue layer before Season 4. Outcome: the starter village routines are ready for the course.

## Done when

A student can clone the composed template, run helper pin tests, and play a local day with villagers beside the scripted visitor. A viewer can watch a full live day, scrub its replay to exact frames, and toggle the collision overlay. A human can play the visitor with pointer and keyboard locomotion, the expression palette and its preview, and chat. `cast_5` and `cast_10` days record and replay identically. Watchers and replay viewers see every delivered line. A human visitor sees broadcasts delivered to `player_0` and direct lines sent to or from `player_0`. The shared conformance suite covers `three_branches` defaults, tests pin all six season presets, and the platform specification identifies Days at Three Branches as its shipped simultaneous mask-free `Dict` environment.

## Later work

- Publish `neighbor` when Season 4 opens, plus any further worked examples.
- Run Season 5 and 6 course operations, including budget advice and rating prompts, as course material rather than platform work.
