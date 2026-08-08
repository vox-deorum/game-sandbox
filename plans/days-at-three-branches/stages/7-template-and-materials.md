# Step 7: Template, helpers, guide, and the worked example

Status: planned.

Part of [the plan](../README.md). This is build-order step 7: the complete student surface. It can begin once step 4 ships the generator and finishes after step 6, because the guide documents human play. The hands-on surface is the full student flow: clone the composed template, run the pin tests, and run a local day with their villagers beside the scripted visitor, following only the published guide.

## Why this is its own seam

The template and guide are what students actually touch, and the helpers are a promise about the engine's physics. Building them against the finished environment keeps the promise checkable: every helper is pin-tested against the engine itself, never a second implementation of the rules.

## What to build

### The template and helpers

The template layer on `templates/base`, with the helper module: `ground_at(position)`, `blocked(a, b)`, `walkable(position)`, `path_to(a, b)` returning valid paths over the layout without promising optimality, `usable_prop(observation)` for the prop a use would select, and the emote-name, action-id, and locomotion builders, the locomotion builder wrapping the heading into range and clamping the speed. Emote names and action ids come from the shared `rules.json`.

### Performance

The compute budget is the real constraint: 120 seconds per game across 1200 ticks leaves 100 milliseconds average per decision against the 250 millisecond cap. `path_to` and the perception helpers get performance tests on pinned generated layouts, and the worked example must finish a day inside the episode budget.

### Guide and example

The canonical student guide at `environments/three_branches/environment.md`, following the documentation conventions and published through the existing pipeline: the observation cookbook, speech timing, seasons arc, and local play. One worked example along Season 1's core techniques (role from the id, wander, idle, a chore loop), kept internal, with `PUBLISHED_EXAMPLES` declared empty.

## Tests

- Helper pin tests against the engine on pinned seeds.
- Helper performance bounds and the example's healthy days on both plans.
- Guide publication through the docs pipeline.

## Done when

The hands-on flow works end to end for a reader of the guide alone, and the pins and budgets hold.
