# Step 6: Template, Helper, Guide, and the Worked Examples

Status: complete.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 6: the completed student surface. It can begin after step 3 (registration) and proceed alongside steps 4 and 5, but cannot finish until step 5 provides human input and local play. The hands-on surface is the full student flow: compose the template, run the pin tests, watch and play locally, and beat naive with the vanguard example.

## Why this is its own seam

The template layer is the student contract, and its centerpiece, the helper package that owns the stable path encoding, is a compatibility promise: once the template is published, the encoding can never change. That deserves a step whose tests exist to freeze it, separate from the environment internals it pins against.

## What to build

### The helper package

`template/sandbox/crane/`, the surface the [environment spec](../environment.md) names, is six small namespaces a student imports individually, for example `from sandbox.crane import action, me, tile, visible`:

- `paths`: `encode(directions)` and `decode(path_id)`, owning the student-facing path encoding. `encode(())` returns `0`, `decode(0)` returns an empty tuple, and ids 1 through `MAX_ID` (1554, at `MAX_STEPS` 4 steps deep) round-trip to direction tuples. Invalid encoded values raise `ValueError`.
- `action`: `move(path_id, target_id=None, observation=None)` and `stay(target_id=None, observation=None)`, returning action Dicts and resolving a target id to its enemy roster slot through the observation. `move` accepts an encoded path id. `legal_paths(observation)` and `possible_targets(observation)` are driven by the authoritative mask, never by a second implementation of the rules, and `legal_steps(observation)` narrows `legal_paths` to the single-step ids, 1 through 6.
- `me`: one reader per field of the unit's own observation: `unit_id`, `side`, `unit_type`, `position`, `direction`, `hit_points`, `movement_points`.
- `visible`: `enemies(observation)` and `allies(observation)`, the units currently in sight.
- `roster`: `allies(observation)` and `enemies(observation)`, the two sides' full starting rosters, visible or not.
- `tile`: hex geometry and the ground: `DIRECTIONS`, `distance(first, second)`, `neighbors(position)`, `at_path_end(position, path_id)`, `at_center(observation)`, `at_mirror(position, observation)`, `terrain_at(observation, position)`.

Deliberately no pathfinder: turning routes into legal orders is Season 2's core technique and stays student work.

### Template and guide

`template/agent.py` completed as an intentionally weak starter that demonstrates one stay, one move, and one named-target order through the helpers, so Season 1's design issue stays open. While it sees no enemy it takes one step in `me.direction(observation)`, checked against `action.legal_steps`. Once an enemy is visible it steps at the nearest one and names it. It keeps no memory between turns, so its `reset` is empty. Both sides run the same starter, and the match ends by elimination in 40 to 47 ticks, about 10 rounds.

`template/README.md` completed. The canonical guide `environments/skirmish_crane/environment.md` finished per [docs/AGENTS.md](../../../docs/AGENTS.md): a student reader with no assumed tooling knowledge, links to published documentation only, walking through the starter agent line by line and then teaching the observation, the mask, the helpers, messaging, and local play, with season variants, terrain, abilities, capture, and wasteland among them, described as instructor-controlled.

### The worked examples

Two, both kept internal, and `PUBLISHED_EXAMPLES` stays empty.

- `marcher`, a study of the starter. Each unit remembers the tile it spawned on and marches on that tile's mirror image (`tile.at_mirror`), which the field's point symmetry places in enemy ground, then closes on the nearest visible enemy the way the template does. Its tests stay light: every order is mask-legal, and a match between marchers ends by elimination well short of the round cap. No beats-naive claim.
- `vanguard`, the Season-3-shaped worked example: an FSM per unit type where the archer falls back and fires in the same activation, the cavalry flanks, and the footman holds the line. Quality bar: beats naive on every pinned seed, playing both seats of the skirmish plan and a pinned pair of Season 3 army battles.

## Tests

- Pin tests under `template/tests/` freeze the encoding forever, now over the namespaced surface: literal vectors ([] = 0, [northeast] = 1, [northwest] = 6, [northeast, northeast] = 7, [northwest x4] = 1554) through `paths.encode`/`paths.decode`, and a full 0 through `paths.MAX_ID` round-trip against the step 1 decoder, plus invalid-value checks and the standard import probe keeping the package free of heavy imports.
- Reader pin tests cover the rest of the package: `tile.at_path_end` against stepwise neighbor walks over the whole id range, `tile.at_mirror`, `tile.at_center`, and `tile.terrain_at`; the `me` readers; the `roster` readers; `visible`'s partition into allies and enemies; `action.legal_steps` as the 1-through-6 subset of `action.legal_paths`; and that `visible.enemies` ids equal `action.possible_targets`.
- Helper accessors agree with raw observations and masks while driving real environment states: `action.legal_paths` and `action.possible_targets` equal the mask bits, `action.move` and `action.stay` produce in-space, mask-legal Dicts, and target-id resolution matches the roster.
- A `template/tests/test_episode.py` end-to-end episode test on the spades pattern, inherited by composed examples.
- Vanguard tests: the FSMs behave on constructed observations, vanguard beats naive on every pinned skirmish seed from both seats and in the pinned Season 3 army battles, and every order it submits is mask-legal.
- Marcher tests, kept light: every order is mask-legal, and a match between marchers ends by elimination well short of the round cap. No beats-naive claim.
- Compose smoke: the composed template and each example build and their inherited tests pass.
- The docs CI lane green with the finished guide at its virtual path.

## Done when

A student-shaped user composes the template, runs `python -m sandbox play` to watch and `python -m sandbox human` to play in the browser, runs the green pin tests, and watches vanguard beat naive on the pinned seeds. This step completes after step 5 supplies that human-play behavior. The guide reads complete against the shipped behavior, and every test above is green.
