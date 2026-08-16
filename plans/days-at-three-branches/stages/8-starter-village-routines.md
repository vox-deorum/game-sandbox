# Step 8: Starter village routines and the dialogue example

Status: complete.

Part of [the plan](../README.md). This closing build-order step extends [step 7](7-template-and-materials.md)'s helpers into one worked example named `neighbor`, which serves the [Season 4](../pedagogy.md#season-4-village-life-week-4) and [Season 5](../pedagogy.md#season-5-the-conversation-week-5) starter material. It builds on the reset contract from [step 1](1-platform-expansions.md) and the human visitor from [step 6](6-human-play.md). Review a ten-villager day that remains believable around a visitor and can hold an in-character conversation.

## Why this is its own seam

Routines and dialogue ship together: each villager continues its day while it talks. The example keeps `sandbox.village` a physics description and gives both seasons a replaceable action space.

## The agent the library serves

Season 4 uses `cast_10` with daynight on. Each villager derives a role from its player id, chooses a routine and goal from phase and perception, revisits that pair at phase boundaries and when `player_0`, the visitor, comes near, then asks that routine for each tick's action. The shipped static role-and-phase schedule uses the interface that students replace with their own design.

1. **Dawn:** leave home with `go_to`.
2. **Morning:** work at stalls, pump, plots, board, and repair bench with `tend` and `wander`.
3. **Midday:** gather at market, inn, and benches with `gather_at`, `rest`, and `watch`.
4. **Evening:** tend lanterns and shrine, then go home with `tend` and `go_to`.
5. **Night:** go home and sleep with `go_to` and `sleep_at`.

Keep Season 3's live visitor reactions: `greet`, `follow`, and `avoid`.

The shipped table assigns the guaranteed pump, board, repair bench, hearth, and bell once, then
spreads three stall jobs and two plot jobs across explicit offsets. `me.rng` varies roles only
within choices that keep those compatible targets. A visitor reaction lasts 40 ticks. Fixed
per-slot return windows leave enough route time for each home, and residents who share a home use
separate interior points. Lanterns are optional dressing, so a resident assigned to a missing
lantern returns to that resident's guaranteed role prop for the evening work period.

## What to build

### Example package and memory

Create `environments/three_branches/examples/neighbor/` with `README.md`, `agent.py`, `routines.py`, `dialogue.py`, and `tests/test_neighbor.py` in the `marcher` and `vanguard` layout. Import modules at the top level. Imports inside `act` resolve against the last-loaded player directory and become shared across players.

`neighbor` is a publication candidate. Keep `PUBLISHED_EXAMPLES` unchanged and record publication at Season 4 opening in the plan's Later work.

A routine is `decide(observation, memory, goal)`: return a helper-built action Dict or `None` when inapplicable. It may change only supplied villager-instance memory, including namespaced routine state and cached routing data. A goal is a position, prop id, player id, or `None`. Do not hide shared state in classes. In `agent.py`, run the assigned routine, then `wander(goal)` on `None`, then stand if it also returns nothing.

### Routing

**Operational rules:** `go_to` searches village cells using `layout.walkable` for nodes, `layout.can_step` for edges, and `layout.ground_at` speed limits for edge cost. It reads semantic static records, delegates collision geometry to helpers, caches its graph in villager memory, and replans after a stall. Document this as a replaceable working approach, not the required routing method.

**Budget and reporting rules:** Build the graph once in `reset`, where step 1 provides the layout before tick one. Later `act` calls search the cached graph. Measure and report reset and per-tick costs separately. The graph resolution remains an explicit example choice that students may change.

The shipped example uses one graph node for every walkable cell. The village helpers cache their
model by immutable layout content and use a spatial collision index, so repeated cell and segment
checks reuse exact static geometry without rescanning every collision shape.

### Routine menu

| Routine | Behavior | Empty-handed when |
| --- | --- | --- |
| go_to(goal) | Follow a routed path toward the goal, re-planning on a stall | Never; standing at the goal qualifies |
| wander(goal) | Drift near the goal, changing heading now and then; also the dispatch fallback | Never |
| tend(goal) | Walk into reach of the goal prop, stop, and hold the use | Goal is not a prop |
| rest(goal) | Take a free bench near the goal and sit | No free bench near the goal |
| gather_at(goal) | Stand within hearing range of whoever is already near the goal, turned toward them | Nobody near the goal |
| greet(goal) | Turn to a character in sight, wave, then hold a station within hearing range | Nobody in sight |
| follow(goal) | Keep a character at a comfortable distance, matching its pace | Target neither in sight nor within hearing |
| avoid(goal) | Open distance from the nearest character while working toward the goal | Nobody in sight or within hearing |
| watch(goal) | Stand still facing the goal and let the village come to it | Never |
| sleep_at(goal) | Inside the goal building, stand still with the sleep emote | Not inside the goal building |

`assign(observation, memory)` returns `(routine, goal)` and is explicitly the Season 4 design seam. At reset it assigns roles through `me.rng`, maps each role to places and props by phase, and recomputes at phase boundaries and when the visitor enters hearing range. Spread roles across districts, avoid funneling ten villagers onto one prop, and exercise `go_to`, `tend`, `gather_at`, `rest`, `sleep_at`, and fallback `wander`. The remaining routines support student schedules.

### Dialogue layer

`dialogue.py` wraps `templates/base`'s `sandbox.llm.BackgroundLLM`, which owns the request thread, one in-flight slot, non-blocking read, and captured error. The controller adds:

- At most one waiting visitor line. A newer line replaces it, and it starts only after the current reply to `player_0` is consumed.
- Prompt with persona and perceived world state only.
- Whitespace normalization and a 200-code-point cap before sending a villager line.
- A canned fallback on budget exhaustion or proxy error.
- A latest-observation validity check before starting a waiting request or returning a reply. Discard a waiting or completed line if the visitor has left hearing range or moved behind a wall.

Use the [environment speech contract](../environment.md#speech) for delivery and visibility. A valid reply is that villager's one direct line for the tick, returned through the shared raw chat interface as `{"to": "player_0", "text": text}`. It is valid only while the visitor is in hearing range with an unblocked line. Routines continue every tick while a reply is in flight.

Use a non-adaptive static schedule and document its approximations.

### CI wiring

The Three Branches browser journey composes `neighbor`, submits it under the demo member, and leaves a Season 4 `Village Life` window open. A fresh full e2e database therefore lets `npm run demo` launch the worked example, while `PUBLISHED_EXAMPLES` remains empty.

Add `("three_branches", "neighbor")` to `scripts/tests/test_compose.py`'s example inventory. Add the example's `routines.py` and `dialogue.py` to `scripts/_envs.py`'s pyright set.

## Tests

`tests/test_neighbor.py` follows the `vanguard` pattern: hand-built observations, an action-space wrapper, and pinned-seed episodes using environment metadata presets.

- A reset smoke test verifies private graphs, stable slots, and a legal first action.
- A schedule test covers ten role-compatible targets, visitor reassignment, and the fixed return-home windows.
- One constructed routine-menu test covers all ten routines, with a focused stalled-route replan regression.
- Fake-proxy dialogue tests cover latest-line replacement, direct capped replies, fallbacks, hearing loss, and a real within-range wall blocking line of sight.
- One pinned full Season 4 `cast_10` day keeps every action in space, requires every resident to move, realizes every commanded use, observes morning and evening work, and finishes with every resident sleeping at home.

The static role table, phase places, and follow and avoid distance bands are defaults the day-arc test may adjust.

## Done when

Under Season 4 parameters, `neighbor` plays a coherent browser day: villagers leave at dawn, work in morning, gather at midday, light lanterns in evening, and sleep at night while noticing the visitor. In a local day, a villager converses in character and falls back to canned lines when its budget ends. Routine, routing, and dialogue tests pass, the example composes in CI, and the plan is complete end to end.
