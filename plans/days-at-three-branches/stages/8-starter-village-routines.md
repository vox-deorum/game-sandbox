# Step 8: Starter village routines and the dialogue example

Status: complete.

Part of [the plan](../README.md). This closing build-order step extends [step 7](7-template-and-materials.md)'s helpers into one worked example named `neighbor`, which is the starter code for [Season 5](../pedagogy.md#season-5-the-conversation-week-5) and [Season 6](../pedagogy.md). It builds on the reset contract from [step 1](1-platform-expansions.md) and the human visitor from [step 6](6-human-play.md). Review a ten-villager day that remains believable around a visitor and can hold an in-character conversation.

## Why this is its own seam

Routines and dialogue ship together: each villager continues its day while it talks. The example keeps `sandbox.village` a physics description and gives both seasons a replaceable action space.

## The agent the library serves

Season 5 uses `cast_10` with daynight on and the LLM API enabled. The shipped day is deliberately plain, so the example teaches the interface without steering students toward one village design. On every tick a villager asks `assign` for a routine and goal from phase and perception, starts a new plan whenever that pair changes, then asks the routine for the tick's action. Students replace the schedule with their own design.

1. **Dawn:** walk from home to the villager's work prop with `go_to`.
2. **Morning:** work there with `tend`.
3. **Midday:** meet at the inn with `gather_at` and say good day to the nearest neighbor.
4. **Evening:** work again with `tend`.
5. **Night:** walk home and sleep with `sleep_at`.

Every villager reacts to the visitor with `greet`. The `follow` and `avoid` reactions from Season 3 stay in the routine menu for student schedules. A visitor reaction lasts 40 ticks and happens once per visit: the villager then returns to its schedule until `player_0`, the visitor, leaves hearing range and comes back.

Villagers discover their own arrangements rather than reading hand-tuned per-slot numbers. The `RESIDENTS` table gives each slot a work prop type and a midday building: the guaranteed pump, board, repair bench, hearth, and bell once each, then three stall and two plot slots. At reset a villager orders every prop of its type by distance from home and starts with the nearest. It moves to the next one, wrapping around, when its own use fails because another villager holds the prop. At night it walks home, heads for the middle of the room, and lies down once it stands still, so a housemate sharing the home can still get past the doorway. The schedule favors plain code over precision: villagers leave work when night starts, not before.

## What to build

### Example package and memory

Create `environments/three_branches/examples/neighbor/` with `README.md`, `agent.py`, `routines.py`, `routing.py`, `dialogue.py`, and `tests/test_neighbor.py` in the `marcher` and `vanguard` layout. Import modules at the top level. Imports inside `act` resolve against the last-loaded player directory and become shared across players.

`neighbor` is published: it is the environment's single entry in `PUBLISHED_EXAMPLES`, so the publisher pushes it to the `examples/three_branches/neighbor` branch of the student repository, while `sweeper` stays internal. The `season_5` and `season_6` presets name it with `example="neighbor"`, so the seeded seasons give students that branch in their setup commands. Its `README.md` therefore describes the runnable checkout a student clones under `--preset season_5`, not the composition step.

A routine is `decide(observation, memory, goal)`: return a helper-built action Dict or `None` when inapplicable. It may change only supplied villager-instance memory, including namespaced routine state and cached routing data. A goal is a position, prop id, player id, or `None`. Do not hide shared state in classes. In `agent.py`, run the assigned routine, then `go_to(goal)` on `None`. That fallback is how a villager reaches the inn before `gather_at` finds company and walks home before `sleep_at` can start. A new plan clears its routine's namespaced state, so, for example, `greet` waves again on each visit.

### Routing

**Operational rules:** `routing.py` owns the route graph and the A\* search, kept apart from the routines so students can replace either. `build_graph` uses `layout.walkable` for nodes, `layout.can_step` for edges, and `layout.ground_at` speed limits for edge cost, and `path` returns the cheapest cell path. `go_to` targets `layout.nearest_walkable` of its goal point, caches its graph in villager memory, and replans after a stall or when it leaves its path. Off the graph it walks to the nearest walkable cell. Short moves around a moving target (`follow`, `avoid`, and repositioning for a prop) take one greedy neighbor step without a full path. Document this as a replaceable working approach, not the required routing method.

**Budget and reporting rules:** Build the graph once in `reset`, where step 1 provides the layout before tick one. Later `act` calls search the cached graph. Measure and report reset and per-tick costs separately. The graph resolution remains an explicit example choice that students may change.

The shipped example uses one graph node for every walkable cell. The village helpers reuse a model by observation identity, fall back to a content-keyed cache by immutable layout content, and use a spatial collision index, so repeated cell and segment checks reuse exact static geometry without rescanning every collision shape.

### Routine menu

| Routine | Behavior | Empty-handed when |
| --- | --- | --- |
| go_to(goal) | Follow a routed path toward the goal, re-planning on a stall; also the dispatch fallback | Never; standing at the goal qualifies |
| wander(goal) | Drift near the goal, changing heading now and then | Never |
| tend(goal) | Walk into reach of the goal prop, stop, and hold the use | Goal is not a prop |
| rest(goal) | Take a free bench near the goal and sit | No free bench near the goal |
| gather_at(goal) | Stand within hearing range of whoever is already near the goal, turned toward them | Nobody near the goal |
| greet(goal) | Turn to a character in sight, wave, then hold a station within hearing range | Nobody in sight |
| follow(goal) | Keep a character at a comfortable distance, matching its pace | Target neither in sight nor within hearing |
| avoid(goal) | Open distance from the nearest character while working toward the goal | Nobody in sight or within hearing |
| watch(goal) | Stand still facing the goal and let the village come to it | Never |
| sleep_at(goal) | Inside the goal building, walk toward its middle, then stand still with the sleep emote | Not inside the goal building |

`assign(observation, memory)` returns `(routine, goal)` and is explicitly the students' design seam. One editable table drives it: `RESIDENTS` holds a `Resident` row per slot, and the README shows how to add a field (such as a per-resident visitor reaction) and read it in `assign`. `assign` runs on every tick, so a student's new condition takes effect without a separate replanning trigger. The shipped day exercises `go_to`, `tend`, `gather_at`, `greet`, and `sleep_at`. The remaining routines support student schedules.

### Dialogue layer

`dialogue.py` wraps `templates/base`'s `sandbox.llm.BackgroundLLM`, which owns the request thread, one in-flight slot, non-blocking read, and captured error. One `Dialogue` per villager handles every conversation, with the visitor and with other villagers:

- One waiting line per speaker, the newest replacing an older one. A neighbor's broadcast is overheard, not answered; the visitor's broadcasts are answered.
- One answer per tick, the visitor's first. `scripted_answer(speaker, text)` is the switch between scripted and LLM dialogue: it returns a line to send at once, or `None` to request an LLM answer. As shipped, the visitor gets LLM answers and neighbors get canned ones, so midday small talk spends no budget.
- `say(to, text)` starts a conversation with one listener or, with `None`, everyone in hearing. It refuses a line the tick's per-listener limit or a pending answer would make invalid.
- `NEIGHBOR_TURNS` caps how many lines a villager says to one neighbor until that neighbor leaves hearing, so two villagers cannot answer each other forever.
- Prompt with persona, conversation partner, and perceived world state only.
- Whitespace normalization and a 200-code-point cap before sending a line.
- A canned fallback on budget exhaustion or proxy error.
- A latest-observation validity check. Discard a waiting line or an in-flight answer once its speaker has left hearing range or moved behind a wall.

Use the [environment speech contract](../environment.md#speech) for delivery and visibility. Answers are direct lines returned through the shared raw chat interface as `{"to": speaker, "text": text}`. Direct lines between villagers reach watchers and replay, not the visitor controller, and the README says so. Routines continue every tick while a reply is in flight.

Use a non-adaptive static schedule and document its approximations.

### CI wiring

Add `("three_branches", "neighbor")` to both the example inventory and the published allowlist in `scripts/tests/test_compose.py`. Add the example's `routines.py`, `routing.py`, and `dialogue.py` to `scripts/_envs.py`'s pyright set.

## Tests

`tests/test_neighbor.py` follows the `vanguard` pattern: hand-built observations, an action-space wrapper, and pinned-seed episodes using environment metadata presets.

- A reset smoke test verifies private graphs, stable slots, and a legal first action.
- A schedule test covers ten distinct work props of the tabled types, each phase's plan, and visitor reassignment.
- A discovery test covers keeping a prop after a successful use and moving to the next one, wrapping around, after a failed use.
- A visitor test covers the 40-tick reaction window and a fresh greeting on a later visit.
- One constructed routine-menu test covers all ten routines, with a focused stalled-route replan regression.
- Fake-proxy dialogue tests cover latest-line replacement, direct capped replies, fallbacks, hearing loss, and a real within-range wall blocking line of sight. A neighbor test covers canned answers, overheard broadcasts, `say` refusals, the turn cap, and a fresh exchange after the neighbor returns.
- One pinned full Season 5 `cast_10` day keeps every action in space, requires every resident to move, realizes every commanded use, observes morning and evening work, and finishes with every resident sleeping at home.

The resident table, the midday building, and the follow and avoid distance bands are defaults the day-arc test may adjust.

## Done when

Under Season 5 parameters, `neighbor` plays a coherent browser day: villagers leave at dawn, work in morning, gather and greet each other at midday, work again in evening, and sleep at night while noticing the visitor. In a local day, a villager converses with the visitor in character and falls back to canned lines when its budget ends. Routine, routing, and dialogue tests pass, the example composes in CI, and the plan is complete end to end.
