# Step 6: Template, Helper, Guide, and the Worked Example

Status: planned.

Part of [the tactical game plan](../README.md). This is build-order step 6: the completed student surface. It needs only step 3 (registration) and can proceed alongside steps 4 and 5. The hands-on surface is the full student flow: compose the template, run the pin tests, watch and play locally, and beat naive with the worked example.

## Why this is its own seam

The template layer is the student contract, and its centerpiece, the helper module that owns the stable path encoding, is a compatibility promise: once the template is published, the encoding can never change. That deserves a step whose tests exist to freeze it, separate from the environment internals it pins against.

## What to build

### The helper module

`template/sandbox/tactical.py`, the surface the [environment spec](../environment.md) names:

- `encode_path(directions)`, owning the student-facing side of the 1 through 1554 encoding.
- `move(path, target_id=None, observation=None)` and `stay(target_id=None, observation=None)`, returning action Dicts and resolving a target id to its enemy roster slot through the observation.
- `legal_paths(observation)` and `nameable_targets(observation)`, driven by the authoritative mask, never by a second implementation of the rules.
- Small non-strategic utilities: hex distance and neighbors.

Deliberately no pathfinder: turning routes into legal orders is Season 2's core technique and stays student work.

### Template and guide

`template/agent.py` completed as an intentionally weak starter that demonstrates one stay, one move, and one named-target order through the helpers, so Season 1's design issue stays open. `template/README.md` completed. The canonical guide `environments/tactical_game/environment.md` finished per [docs/AGENTS.md](../../../docs/AGENTS.md): a student reader with no assumed tooling knowledge, links to published documentation only, teaching the observation, the mask, the helpers, messaging, and local play, with season variants described as instructor-controlled.

### The worked example

Exactly one, kept internal, Season-1-shaped: an FSM per unit type where the archer falls back and fires in the same activation, the cavalry flanks, and the footman holds the line. Quality bar: beats naive across a pinned seed set. `PUBLISHED_EXAMPLES` stays empty.

## Tests

- Pin tests under `template/tests/` freeze the encoding forever: literal vectors ([northeast] = 1, [northwest] = 6, [northeast, northeast] = 7, [northwest x4] = 1554) and a full 1554-id round-trip against the step 1 decoder, plus the standard import probe keeping the helper free of heavy imports.
- Helper accessors agree with the raw observation and mask on recorded fixtures: `legal_paths` and `nameable_targets` equal the mask bits, `move` and `stay` produce in-space, mask-legal Dicts, and target-id resolution matches the roster.
- A `template/tests/test_episode.py` end-to-end episode test on the spades pattern, inherited by composed examples.
- Example tests: the FSMs behave on constructed observations, and the example beats naive across the pinned seed set.
- Compose smoke: the composed template and example build and their inherited tests pass.
- The docs CI lane green with the finished guide at its virtual path.

## Done when

A student-shaped user composes the template, runs `python -m sandbox play` to watch and `python -m sandbox human` to play in the browser, runs the green pin tests, and watches the worked example beat naive on the pinned seeds. The guide reads complete against the shipped behavior, and every test above is green.
