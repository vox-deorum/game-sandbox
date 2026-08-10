# Step 3: Crane Reach Renderer, View and Replay, and Registration

Status: Done.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 3: the first hex-grid renderer, draw-only and in a deliberate placeholder style, and the registration step that makes the environment public. The hands-on surface is the web app: the Crane Reach card on the home page, a watchable live match, a scrubbable replay, and `npm run play` in watch mode.

## Why this is its own seam

Registration is atomic: `environments/test_conformance.py` requires the complete authoring shape (environment.md, renderer/index.ts, one renderer thumbnail, tests/, template/agent.py, template/README.md, at least one example agent, and the pyproject entry point) the moment an environment is recognized, and forbids a renderer directory on an ignored package. So the renderer cannot land before registration, and registration cannot land without seed versions of every participant artifact. This step carries both: the smaller, safer half of the renderer (drawing, no input), and honest v1 seeds that steps 5 through 7 complete. Splitting drawing from input also keeps the riskiest renderer work, the legality engine, in its own step.

## What to build

Remove `skirmish_crane` from `environments/.envignore` and run `npm run sync:envs`: the entry point and `backend/src/environments/generated/environments.json` regenerate, the shared conformance suite starts covering Skirmish at Crane Reach at default parameters, and `scripts/play.py` can load the environment. Stage the naive builtin under `backend/images/session-base/deps-v1/builtin/skirmish_crane/naive/`. The versioned session image explicitly imports and validates Crane Reach with the other registered builtins during its build.

### Seed participant artifacts

Registration demands them now; their completing steps finish them. Each seed is honest and minimal, never filler to delete later:

- `environment.md` v1: a short, correct guide (step 6 completes it).
- `template/agent.py` v1: a legal starter that observes and stands still, with `template/README.md` v1 (step 6 completes both).
- One internal example's v1 under `examples/` (step 6 completes it). `PUBLISHED_EXAMPLES` stays empty.
- A renderer thumbnail placeholder (step 4.1 finalizes it).

### Renderer

`environments/skirmish_crane/renderer/` in TypeScript on PixiJS: `index.ts` default-exports `{key: "crane-reach-field", renderer, thumbnail}`, and a pure `computeScene(state, config)` in `scene.ts` maps overlay state to drawable structures. Pointy-top hexes on axial coordinates. Decisions:

- Placeholder visual style on purpose: functional flat shapes and labels that make the game readable (terrain, features, zones, units with hit points, activation highlight, round and capture HUD) without committing to an identity. Step 4.1 designs the identity using this renderer as the workbench, so `computeScene` keeps style swappable: geometry and content in the scene, appearance in one styling layer.
- The scene builder derives its tile-code table (which single-character wire code maps to which terrain and feature pair) from the package's `tile_types.json` directly, rather than keeping its own copy, so the rules engine and the renderer cannot drift. The renderer's own style and mark tables, colors and terrain and feature marks, stay hand-written, keyed by the names `tile_types.json` declares.
- Draw-only: `sendAction` unused, and without `controlledPlayers` the view is the full board, which is the spectator and replay rule.
- Layering for 40 units across 6000 ticks: build the static battlefield layer once at mount from `ctx.header.overlay_static`, then reconcile units and animate the dynamic overlay's most recent events. Seeks use snap semantics, and durations scale with the paced host's cadence, a minimum delivery interval rather than a budget. Version 1 dynamic events supply each exact executed path id, which the event layer expands into its entered-tile route.
- Reuse from `frontend/src/renderers/base/PixiRenderer.ts` (mount loop, resize, pending-state cache, layer clearing, the text node factory, and the tracked display scale); the card-table stack does not apply, so grid scaffolding is renderer-local.
- Behind the `index.ts` entry, which owns the renderer's state and decides what to draw when, the work is split into modules: `presentation.ts`, `timeline.ts`, and `transitions.ts` hold the tunable logic (sizes at a given display scale, the beats of an event, when an event animates), and `board.ts`, `units.ts`, `hud.ts`, and `draw.ts` hold the drawing. Each is independently testable, and `scene.ts` stays the pure model with no Pixi imports.

### Fixtures and tests

`scripts/gen_crane_fixture.py` on the `_fixture_common` pattern generates two recordings into `frontend/test/fixtures/`: a plain skirmish at Season 1 defaults and a full-variant army, the Season 6 shape with wasteland on. The army fixture doubles as the perf-test input. Beside each recording, it writes a compact test-only legality file. Its first entry is the opening state: the live-only pre-action frame is not recorded, so this entry carries that whole state, overlay included, and the generator drives an `Episode` and calls `opening_state()` rather than going through `run_and_copy`. Every later entry points into the recording by tick and repeats the overlay's `current_activation`. Each entry stores the expected path and target masks as Base64-encoded bit vectors. These legality files are test artifacts only: they do not appear in production recording headers, recordings, or live streams.

### Spec and docs reconciliation

Registration makes Skirmish at Crane Reach the platform's first shipped Dict-action environment, so the platform spec updates land here, in the same change set: the sentence in [docs/specs/environment.md](../../../docs/specs/environment.md) stating that every current environment uses a flat integer action is rewritten, the mask-and-overlay provider list gains Crane Reach, and the Composite actions section names Crane Reach as the shipped consumer. The docs CI lane runs green with the v1 guide discovered at its virtual path.

### Browser journey

`frontend/e2e/crane-reach/crane-reach.spec.ts` enters `e2e.yml` with the spectate half: watch a session to game over, scrub the replay to exact frames, and a season journey on the spades pattern (an admin creates a Crane Reach season, takes its gameplay from the named Season 5 preset in the config editor, and turns the capture target and round cap down by hand; the published example agent is submitted against naive, a scheduled matchup runs, results release).

## Tests

- The shared conformance suite green with Skirmish at Crane Reach registered, including the authoring-shape and renderer-ownership checks.
- Scene tests (vitest, jsdom) against both fixtures: hex layout and geometry, terrain and feature mapping, void surround, unit placement and hit points, zone drawing, activation highlight, HUD values, seek determinism (same state, same scene).
- Fixture tests verify the opening legality entry and every actionable recorded state. Production recordings remain free of legality data, stay below 6.5 MiB for the full-variant army case, and keep their headers below 16 KiB.
- A perf smoke on the army fixture in the typescript lane: scene computation across the full recording within a pinned time budget.
- The Playwright spectate journey above, in CI.

## Done when

The Crane Reach card appears on the home page with its thumbnail, a live naive-vs-naive skirmish and an army match are watchable in the web app at its cadence, replay seeks land on identical frames, and `npm run play -- skirmish_crane watch` runs a rendered local match in watch mode. The shared conformance suite, the scene tests, the perf smoke, the docs lane, and the spectate journey are green.
