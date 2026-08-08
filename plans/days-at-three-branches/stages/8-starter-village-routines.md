# Step 8: Starter village routines and the dialogue example

Status: planned.

Part of [the plan](../README.md). This is build-order step 8 and the closing step: the on-ramps [pedagogy.md](../pedagogy.md) promises for Season 4 and Season 5, shipped as one worked example named `neighbor`. It carries the routine library and its routing, and the dialogue layer that answers the visitor in character. The hands-on surface is a village whose ten villagers keep a believable day around a human visitor, and hold a conversation with them.

## Why this is its own seam

Season 4's design issue is a village that keeps living around the player, and Season 5's is grounded dialogue. Both need a working action space on day one of their season, and both are student-facing library code with their own interface contract, distinct from the helpers they build on. Routing lives here rather than in the template, which is what keeps `sandbox.village` a description of the engine's physics and leaves the interesting work to students.

They ship together because they are one example. Season 5's dialogue rides beside Season 4's routines: a villager holds a conversation while it goes on with its day, so splitting them would mean two examples that only work when combined.

## The agent the library serves

Season 4 runs `cast_10` with daynight on. A working agent is, per villager: take a role from its character id, pick a routine and a goal from the day phase and what it perceives, revisit that pair at each phase boundary and when the visitor comes near, and let the chosen routine produce each tick's action.

The day arc names every routine the library needs:

1. **Dawn.** Villagers leave their homes for the first place their role wants. Routines: `go_to`, the routed walk.
2. **Morning.** Work: tending a stall, working the pump, tending a plot, reading the board, working the repair bench. Routines: `tend`, `wander`.
3. **Midday.** The village gathers at the market, the inn, and the benches. Routines: `gather_at`, `rest`, `watch`.
4. **Evening.** Lanterns are lit, the shrine is tended, and the village drifts home. Routines: `tend`, `go_to`.
5. **Night.** Home and asleep. Routines: `go_to`, `sleep_at`.

Across all of it, the visitor reactions Season 3 introduced stay live: `greet`, `follow`, `avoid`.

The arc describes the student's agent. The shipped example wires a static role-and-phase schedule through the same interface, so the slot the student's own design fills stays visible and replaceable.

## What to build

### The example package

`environments/three_branches/examples/neighbor/` follows the `marcher` and `vanguard` layout: `README.md`, `agent.py`, `routines.py`, `dialogue.py`, and `tests/test_neighbor.py`. `agent.py` imports its modules at module top. The harness isolates top-level imports per player, while an import inside `act` would resolve against the last-loaded player's directory and be shared across players.

`neighbor` is a publication candidate. This step leaves `PUBLISHED_EXAMPLES` unchanged, and adding it when Season 4 opens is recorded in the plan's Later work.

### The routine interface

A routine is a pure decision function: `decide(observation, memory, goal)` returns an action Dict built through the helpers, or `None` meaning the situation is not the routine's. `memory` is the villager's own instance dict, with routine state under namespaced keys, and `goal` is a position, a prop id, a character id, or `None`. No classes with hidden state: the villager's code owns its memory, matching the ruleset's no-shared-controller rule.

The dispatch contract in `agent.py`: run the assigned routine, on `None` run `wander(goal)`, and stand still when even that returns nothing.

### Routing

`go_to` is where pathfinding lives. It builds a coarse walkable graph once from `observation["village"]` through `layout.walkable` and `layout.blocked`, caches it in the villager's own memory, and searches it for a route, re-planning when the villager stalls against geometry the graph coarsened away. It is documented as one workable approach rather than the right one, and as the first thing a student with a better idea should replace.

The graph is built once per episode and never per tick, because the per-decision budget is real. The tests measure it.

### The routine menu

Ten routines, each typed to a job and testable in isolation:

| Routine | Behavior | Empty-handed when |
| --- | --- | --- |
| go_to(goal) | Follow a routed path toward the goal, re-planning on a stall | Never; standing at the goal qualifies |
| wander(goal) | Drift near the goal, changing heading now and then; also the dispatch fallback | Never |
| tend(goal) | Walk into reach of the goal prop, stop, and hold the use | Goal is not a prop |
| rest(goal) | Take a free bench near the goal and sit | No free bench near the goal |
| gather_at(goal) | Stand within talk range of whoever is already near the goal, turned toward them | Nobody near the goal |
| greet(goal) | Turn to a character in sight, wave, then hold a talk-range station | Nobody in sight |
| follow(goal) | Keep a character at a comfortable distance, matching its pace | Target neither in sight nor within hearing |
| avoid(goal) | Open distance from the nearest character while working toward the goal | Nobody in sight or within hearing |
| watch(goal) | Stand still facing the goal and let the village come to it | Never |
| sleep_at(goal) | Inside the goal building, stand still with the sleep emote | Not inside the goal building |

### The schedule hook

`assign(observation, memory)` returns a (routine, goal) pair, and is explicitly labeled as the thing the student's Season 4 design replaces. The static schedule takes a role from the character id through `me.rng` at reset, maps each role to a place and a prop per day phase, and recomputes the pair at each phase boundary and when the visitor enters talk range. Roles spread the cast across the village's districts so ten villagers do not funnel onto one prop, and the spread exercises `go_to`, `tend`, `gather_at`, `rest`, `sleep_at`, and the `wander` fallback. The rest of the menu is there for the student's own schedule.

### The dialogue layer

`dialogue.py` is a thin controller over `templates/base`'s existing `sandbox.llm.BackgroundLLM`, which already owns the request thread, the single in-flight slot, the non-blocking read, and the captured error. The controller adds what the game needs:

- One waiting visitor line at most. A newer line replaces an older one, and a waiting line starts only once the current reply has been consumed.
- Persona and world-state prompting from the villager's role and what it currently perceives, so a reply refers only to true village state.
- Whitespace normalization and truncation to 200 code points before the reply is sent as a talk.
- A canned fallback on budget exhaustion or a proxy error.
- A validity re-check against the latest observation before starting a waiting request or returning a reply. A visitor that has left talk range or moved behind a wall gets the waiting line or completed reply discarded, so the controller never hands back a direct message the recipient policy would drop.

The controller runs beside the routines rather than in place of them: the villager keeps acting on every tick while a reply is in flight, which is the whole reason the request rides across ticks.

### Honest strength

The example's value is the interface and the menu, not its rating. It ships a static schedule with no adaptivity and documented approximations, because the schedule is the season's own work.

### CI wiring

The example inventory assertion in `scripts/tests/test_compose.py` gains `("three_branches", "neighbor")`, and the pyright file set in `scripts/_envs.py` gains per-example additions so the composed tree type-checks `routines.py` and `dialogue.py`.

## Tests

`tests/test_neighbor.py`, in the `vanguard` pattern: hand-built observations, a wrapper asserting every returned action is in space, and pinned-seed episodes whose parameters come from the environment metadata presets rather than re-declared literals.

- Per-routine behavior on constructed observations: `go_to` closes distance along a route, `tend` stops inside reach and commands speed 0, `rest` reaches a free bench and holds the sit, `gather_at` ends within talk range of a bystander, `greet` turns and waves, `follow` holds its distance band, `avoid` raises the minimum distance to the nearest character, `watch` and `sleep_at` stand still, and `wander` never returns `None`.
- A fuzz run drives every routine through full Season 4 episodes and asserts every returned action is in space and every commanded use is actually taken by the engine.
- Routing reaches every named place from every home across a pinned seed batch, and the graph is built once per episode: per-tick decision cost stays inside the per-decision budget with the graph cached, measured rather than assumed.
- A day-arc bar on a pinned Season 4 seed: every villager leaves home, reaches at least three districts, holds at least one prop use in each of the working phases, and is home by the end of night. The bar is absolute, because a bar relative to another example would flip whenever either side is tuned.
- Dialogue controller against a fake proxy: request lifecycle across ticks, reply delivery as a talk, fallback on exhaustion and on errors, over-cap replies truncated, a newer visitor line replacing a waiting one, and a visitor leaving talk range while a request or a waiting line exists.
- `neighbor` completes healthy days with the LLM enabled and disabled, on both plans, inside the decision and episode budgets.

The static role table, the per-phase places, and the follow and avoid distance bands are defaults the day-arc test may adjust.

## Done when

`neighbor` plays a coherent day in the browser under Season 4 parameters: villagers leave their homes at dawn, work their props through the morning, gather at midday, light the lanterns in the evening, and are asleep by night, while noticing the visitor as they pass. A villager holds an in-character conversation with the visitor in a local day and falls back to canned lines when its budget runs out. All routine, routing, and dialogue tests are green, the example composes in CI, and the Days at Three Branches plan is complete end to end.
