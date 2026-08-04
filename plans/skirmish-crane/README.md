# Skirmish at Crane Reach: Implementation Plan

Status: in progress. Steps 1 and 2 are complete.

## Goal

Ship Skirmish at Crane Reach as a complete Game Sandbox environment: a student can clone the template, build a unit program against the published guide, watch and play matches in the browser, and compete on seasonal ladders across the six-season arc, with `naive` as the shipped builtin.

## Scope

Build everything the [environment specification](environment.md) calls the platform implementation: the rules engine for the [ruleset](ruleset.md) with all four variants, the PettingZoo environment with its two-component Dict action space and masks, the `crane-reach-field` hex renderer with human play, the template layer with the skirmish helper module, the canonical student guide, one worked example, and the Season 4 starter tactical block library from [pedagogy.md](pedagogy.md).

Non-goals, recorded so they stay deliberate:

- The bronze, silver, and gold instructor anchors are later work. The first implementation ships `naive` alone, and the specification's builtin table describes the eventual state.
- Exactly one worked example, kept internal. `PUBLISHED_EXAMPLES` stays empty.

## Spec references

[ruleset.md](ruleset.md), [environment.md](environment.md), [pedagogy.md](pedagogy.md), and on the platform side [environment.md](../../docs/specs/environment.md) (contract, composite actions, parameters, seat plans), [communication.md](../../docs/specs/communication.md), [interaction.md](../../docs/specs/interaction.md), [leaderboard.md](../../docs/specs/leaderboard.md), [recording.md](../../docs/specs/recording.md), [submission.md](../../docs/specs/submission.md).

## Depends on

The completed platform stages, in particular environment variants (14), wide seats (15), named builtins (16), the canonical zod contract (18), and composite action spaces (19). Skirmish at Crane Reach is the first shipped Dict-action environment. Browser whole-side control is already available. The local launchers are not yet at parity with it, so step 5 carries that platform work: `scripts/play.py` gains the whole-side companion value, and the shared template launcher gains wide-seat human control for every environment.

## Build order

Each step is its own subplan under [stages/](stages/) and ends with something you can put hands on. Steps 1 through 5 form a chain. Step 6 can begin after step 3 and proceed alongside steps 4 and 5, but it cannot finish until step 5 provides human input and local play. Step 7 closes the stage after step 6.

1. **[Rules engine](stages/1-rules-engine.md).** The complete ruleset as pure, heavily tested Python: hex battlefield generation under the symmetry and connectivity guarantees, activation resolution, all variants, end conditions, and 0-100 team scores. A seed and scripted orders reproduce the same match. Hands-on: a seeded scripted match runs round by round in ASCII and replays identically.
2. **[PettingZoo environment, metadata, and naive](stages/2-pettingzoo-environment.md).** The AEC environment on the engine: both seat plans, every gameplay parameter, the {path, target} action space with per-component masks, the observation, the overlay, the chat policy, the metadata, and the naive agent. Still unregistered. Hands-on: full skirmish and army episodes run through the harness and record to JSONL within the size budget.
3. **[Crane Reach Field renderer, view and replay, and registration](stages/3-renderer-view-and-registration.md).** The hex renderer in a deliberate placeholder style, and registration: the package joins the catalog with seed versions of the participant artifacts. Hands-on: watch a live naive match and scrub its replay in the web app, and `npm run play` runs a rendered local match in watch mode.
4. **[Art style and UI](stages/4-art-style-and-ui.md).** The visual identity, designed and iterated on the live renderer and signed off by the owner. Hands-on: both fixture recordings replay in the final style.
5. **[Human play](stages/5-human-play.md).** Fog of war, legal-by-construction order composition, and the move clock, with renderer legality provably agreeing with the environment's masks. It also brings both local launchers up to the browser's wide-seat control. Hands-on: control a seat's primary unit with a companion, or control the whole side, in the browser and in local play.
6. **[Template, helper, guide, and the worked example](stages/6-template-and-materials.md).** The completed student surface: the skirmish helper module owning the stable path encoding, the finished guide, and the internal example. Hands-on: the full student flow from clone to a local win over naive.
7. **[Season 4 starter tactical blocks](stages/7-starter-tactical-blocks.md).** The predefined tactical block library in the template layer, with tests. Hands-on: a block-driven side maneuvers coherently in the browser.

## Done when

A student can clone the composed template, run the helper pin tests, beat naive locally on a pinned seed set, and play a seat's primary unit with a companion or control the whole side in the browser under fog, with only walkable paths and nameable targets offered. An army season resolves 0-100 team scores identically for a side's 20 players, replays seek to exact frames, a full 6000-tick army recording stays within the 10 MB budget, the shared conformance suite covers Skirmish at Crane Reach defaults, and the platform specification names Skirmish at Crane Reach as its shipped composite-action environment.

## Later work

- The bronze, silver, and gold instructor anchors, planned when the course needs them.
- Publication timing for the block library: in the day-one template or in the template version bumped before Season 4. Course ops decides; the repo ships it either way.
- Season 5 and 6 operations (demonstration collection, compute-cap advice) as course material, not platform work.
