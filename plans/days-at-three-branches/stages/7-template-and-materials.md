# Step 7: Template, helpers, guide, and the worked example

Status: planned.

Part of [the plan](../README.md). This is build-order step 7: the complete student surface. It can begin once step 4 ships the generator and finishes after step 6, because the guide documents human play. The hands-on surface is the full student flow: clone the composed template, run the pin tests, and run a local day with their villagers beside the scripted visitor, following only the published guide.

## Why this is its own seam

The template and guide are what students actually touch, and the helpers are a promise about the engine's physics. Building them against the finished environment keeps the promise checkable: every helper is pin-tested against the engine itself, never a second implementation of the rules.

## What to build

### The template and helpers

The game-specific template layer lives at `environments/three_branches/template`, composed with `templates/base`. Each Agent instance owns one `VillageMap` for the current episode. `reset(seed)` clears it, and the first `act(observation)` call rebuilds it from `observation["village"]`. It provides `ground_at(position)`, `blocked(a, b)`, `walkable(position)`, and `path_to(a, b)`, returning valid paths without promising optimality. No layout lives in module-global state.

Standalone helpers include `usable_prop(observation)`, `character_seed(session_seed, character_id)`, emote-name and action-id lookups, and locomotion builders. `character_seed` joins the session seed's canonical base-10 integer text, a colon, and the exact character id. It hashes those UTF-8 bytes with SHA-256 and returns the first eight digest bytes as an unsigned big-endian integer from 0 through 2^64 - 1. This gives each NPC a stable random stream after it learns its id, without changing the platform seed contract. Pin these test vectors:

| Session seed | Character id | Derived seed |
| --- | --- | --- |
| 0 | npc_0 | 14089798750116722779 |
| 0 | npc_1 | 8874553580198532509 |
| 42 | npc_0 | 2142610074790184181 |

The locomotion builder wraps the heading into range and clamps the speed. Emote names and action ids come from the shared `rules.json`.

### Performance

The compute budget is the real constraint: 120 seconds per game across 1200 ticks leaves 100 milliseconds average per decision against the 250 millisecond cap. `path_to` and the perception helpers get performance tests on pinned generated layouts, and the worked example must finish a day inside the episode budget.

### Guide and example

The canonical student guide at `environments/three_branches/environment.md`, following the documentation conventions and published through the existing pipeline: the observation cookbook, speech timing, seasons arc, and local play. One worked example along Season 1's core techniques (role from the id, wander, idle, a chore loop), kept internal, with `PUBLISHED_EXAMPLES` declared empty.

## Tests

- Helper pin tests against the engine on pinned seeds, including `VillageMap` initialization, reset, different seeds, multiple Agent instances, and the fixed `character_seed` vectors above.
- Helper performance bounds and healthy days on both plans for the composed template and the composed internal example, within the decision and episode budgets.
- The copied canonical guide publishes through the docs pipeline. Examples CI runs on the composed output, and a separate pin keeps `PUBLISHED_EXAMPLES` empty.

## Done when

The hands-on flow works end to end for a reader of the guide alone, and the pins and budgets hold.
