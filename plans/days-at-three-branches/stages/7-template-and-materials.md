# Step 7: Template, helpers, guide, and the worked example

Status: planned.

Part of [the plan](../README.md). This is build-order step 7: the complete student surface. It can begin once step 4 ships the generator and finishes after step 6, because the guide documents human play. The hands-on surface is the full student flow: clone the composed template, run the pin tests, and run a local day with their villagers beside the scripted visitor, following only the published guide.

## Why this is its own seam

The template is what students actually touch, and the helpers are a promise about the engine's physics. Building them against the finished environment keeps the promise checkable: every helper is pin-tested against the engine itself, never a second implementation of the rules.

## What to build

### The helper package

`template/sandbox/village/`, the surface the [environment specification](../environment.md) names, is seven small namespaces a student imports individually, for example `from sandbox.village import action, me, people, props`:

- `action`: `EMOTES`, the nine emote names; `walk(heading, speed, expression="none")` and `stand(heading, expression="none")`, which wrap the heading into range and clamp the speed. `expression` takes `"none"`, an emote name, or `"use"`, and anything else raises `ValueError`. One call is one whole order, so a villager walks and waves together the way the ruleset lets it.
- `me`: one reader per field of the villager's own observation, `character_id`, `position`, `heading`, `moved`, `expression`, and `home`, plus `rng(observation, session_seed)`, a `random.Random` unique to this character.
- `people`: `seen(observation)` and `nearby(observation)`, the characters in the vision cone and the ones within hearing; `visitor(observation)`, the visitor when it is in sight; `roster(observation)`, every character in the match with its home.
- `props`: `all(observation)`, every prop's id, type, and position as standing knowledge; `seen(observation)`, the ones whose state is currently perceived; `in_reach(observation)`; `usable(observation)`, the prop a use would take on this tick; and `TYPES`, the catalog from `props.json`.
- `layout`: the static village, `ground_at`, `walkable`, `blocked`, `buildings`, `building`, `doorway`, `spawn`, and `SPEED_LIMITS`, all working from the layout's derived wall segments.
- `geometry`: pure math on positions and headings, `distance`, `heading_to`, `wrap`, and `in_cone`, plus the character profile's ranges and body radius.
- `day`: `tick`, `phase`, `bell_ringing`, and `parameters`.

Every function takes the observation first and is either a stateless reader or a pure builder. There is no map object to construct, reset, or carry across episodes, and no layout in module-global state: any caching is keyed on the layout content and invisible from the outside. Nothing here decides anything, and deliberately no pathfinder, the rule `sandbox.crane` already states. Routing between the village's places is step 8's work.

`me.rng` seeds a `random.Random` from the session seed and the character id, so a villager gets a stable stream of its own once it has read its id.

### Template and guide

`template/agent.py` as an intentionally weak starter that demonstrates a walk, a stand, an emote, and a use through the helpers, so Season 1's design issue stays open. It heads for its doorway while it is inside its home and for the well plaza once it is out, waves at any villager in sight, and sits when a bench is in reach. It keeps no memory between ticks, so its `reset` is empty. It also does no routing, so a wall between it and the well stops it, which is the first thing a student fixes.

`template/README.md` in the pattern of the Skirmish at Crane Reach template README. The canonical guide at `environments/three_branches/environment.md` follows [docs/AGENTS.md](../../../docs/AGENTS.md) and the section order Skirmish at Crane Reach established: start with the template, make an action, how the starter agent works, your first improvement, match flow, seats and villagers, the village with its grounds and props, scoring, the helpers table, season settings, time limits, messaging, and a raw reference appendix carrying the action ids and the full observation field list. A student reads names throughout and meets the `Discrete(11)` action encoding only in the appendix.

Three rules earn their own worked passage in the guide, because each fails silently:

- A use needs stillness. Commanding any speed above 0 resolves the expression to none, and `props.usable` is how a villager checks what it would take before committing.
- Speech arrives late. A line spoken on tick T reaches its hearers during T+1, after that tick's action is chosen, so the earliest action that can answer it is T+2's.
- `nearby` carries no speech. It is presence by sound, id and position only; the lines themselves come through the inbox.

### The worked example

`sweeper`, one Season 1 example kept internal, in the `marcher` and `vanguard` layout: `README.md`, `agent.py`, and `tests/test_sweeper.py`. It takes a role from its character id through `me.rng`, wanders its own quarter of the village, idles, and runs a chore loop on a prop its role owns. Its quality bar is legibility rather than score: a viewer watching one minute can say what each villager was doing. `PUBLISHED_EXAMPLES` stays empty, matching Skirmish at Crane Reach.

### CI wiring

The example inventory assertion in `scripts/tests/test_compose.py` gains `("three_branches", "sweeper")`, and the pyright file set in `scripts/_envs.py` gains the `sandbox/village/` entry so the composed tree type-checks.

## Tests

- Helper accessors agree with raw observations while driving real environment states, in the pattern of `template/tests/test_crane.py`: every `me`, `people`, `props`, and `day` reader against the observation it reads, and `action.walk` and `action.stand` producing in-space Dicts and rejecting unknown expressions.
- `layout.ground_at`, `layout.walkable`, and `layout.blocked` pinned against the engine's own ground classifier and derived wall segments across a pinned seed batch, so the helpers can never drift from the physics.
- `props.usable` equals the prop `env.step` actually selects, across the reach boundary, the tie rule, the stillness rule, and a blocked line. `props.TYPES` pinned against `props.json` and the `geometry` constants against `rules.json`.
- Isolation: two Agent instances and two episodes never see one another's layout, and a `reset` between episodes changes nothing a student has to remember.
- `me.rng` behavioral pins: the same seed and id yield the same stream, different ids yield different streams, and a stream is stable across runs.
- The standard import-lightness probe keeps the package free of the environment engine and every third-party dependency.
- A `template/tests/test_episode.py` end-to-end episode test on the spades pattern, inherited by composed examples.
- Healthy days on both plans for the composed template and for `sweeper`, inside the per-decision and per-game budgets, and a measurement of real seconds per tick for a cast_10 day recorded against the 250 millisecond cadence.
- The copied canonical guide publishes through the docs pipeline. Examples CI runs on the composed output, and a separate pin keeps `PUBLISHED_EXAMPLES` empty.
- Compose smoke: the composed template and `sweeper` build, and their inherited tests pass.

## Done when

A student-shaped reader composes the template, runs the green pin tests, watches a local day with `python -m sandbox play`, and plays the visitor beside their own villagers, following the published guide alone. The guide reads complete against the shipped behavior, and the pins and budgets hold.
