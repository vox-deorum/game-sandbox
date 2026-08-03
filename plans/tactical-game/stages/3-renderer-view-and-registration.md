# Step 3: Tactical-Field Renderer, View and Replay, and Registration

Status: planned.

Part of [the tactical game plan](../README.md). This is build-order step 3: the first hex-grid renderer, draw-only and in a deliberate placeholder style, and the registration step that makes the environment public. The hands-on surface is the web app: the tactical card on the home page, a watchable live match, a scrubbable replay, and `npm run play` in watch mode.

## Why this is its own seam

Registration is atomic: `environments/test_conformance.py` requires the complete authoring shape (environment.md, renderer/index.ts, renderer/thumbnail.svg, tests/, template/agent.py, template/README.md, at least one example agent, and the pyproject entry point) the moment an environment is recognized, and forbids a renderer directory on an ignored package. So the renderer cannot land before registration, and registration cannot land without seed versions of every participant artifact. This step carries both: the smaller, safer half of the renderer (drawing, no input), and honest v1 seeds that steps 5 through 7 complete. Splitting drawing from input also keeps the riskiest renderer work, the legality engine, in its own step.

## What to build

Remove `tactical_game` from `environments/.envignore` and run `npm run sync:envs`: the entry point and `backend/src/environments/generated/environments.json` regenerate, the shared conformance suite starts covering tactical at default parameters, and `scripts/play.py` can load the environment. Stage the naive builtin under `backend/images/session-base/deps-v1/builtin/tactical_game/naive/`.

### Seed participant artifacts

Registration demands them now; their completing steps finish them. Each seed is honest and minimal, never filler to delete later:

- `environment.md` v1: a short, correct guide (step 6 completes it).
- `template/agent.py` v1: a legal starter that observes and stands still, with `template/README.md` v1 (step 6 completes both).
- One internal example's v1 under `examples/` (step 6 completes it). `PUBLISHED_EXAMPLES` stays empty.
- `renderer/thumbnail.svg` placeholder (step 4 finalizes it).

### Renderer

`environments/tactical_game/renderer/` in TypeScript on PixiJS: `index.ts` default-exports `{key: "tactical-field", renderer, thumbnail}`, and a pure `computeScene(state, config)` in `scene.ts` maps overlay state to drawable structures. Pointy-top hexes on axial coordinates. Decisions:

- Placeholder visual style on purpose: functional flat shapes and labels that make the game readable (terrain, features, zones, units with hit points, activation highlight, round and capture HUD) without committing to an identity. Step 4 designs the identity using this renderer as the workbench, so `computeScene` keeps style swappable: geometry and content in the scene, appearance in one styling layer.
- Draw-only: `sendAction` unused, and without `controlledPlayers` the view is the full board, which is the spectator and replay rule.
- Layering for 40 units across 6000 ticks: a static battlefield layer built once per episode, a reconciled unit layer, and an event layer animating the overlay's most recent events, with snap semantics on seeks and durations scaled to the 150 ms cadence.
- Reuse from `frontend/src/renderers/base/PixiRenderer.ts` (mount loop, resize, pending-state cache); the card-table stack does not apply, so grid scaffolding is renderer-local.

### Fixtures and tests

`scripts/gen_tactical_fixture.py` on the `_fixture_common` pattern generates two recordings into `frontend/test/fixtures/`: a plain skirmish at Season 1 defaults and a full-variant army. The army fixture doubles as the perf-test input.

### Spec and docs reconciliation

Registration makes tactical the platform's first shipped Dict-action environment, so the platform spec updates land here, in the same change set: the sentence in [docs/specs/environment.md](../../../docs/specs/environment.md) stating that every current environment uses a flat integer action is rewritten, the mask-and-overlay provider list gains tactical, and the Composite actions section names tactical as the shipped consumer. The docs CI lane runs green with the v1 guide discovered at its virtual path.

### Browser journey

`frontend/e2e/tactical.spec.ts` enters `e2e.yml` with the spectate half: watch a session to game over, scrub the replay to exact frames, and a season journey on the spades pattern (an admin creates a tactical season with variant overrides and naive seats, a scheduled matchup runs, results release).

## Tests

- The shared conformance suite green with tactical registered, including the authoring-shape and renderer-ownership checks.
- Scene tests (vitest, jsdom) against both fixtures: hex layout and geometry, terrain and feature mapping, void surround, unit placement and hit points, zone drawing, activation highlight, HUD values, seek determinism (same state, same scene).
- A perf smoke on the army fixture in the typescript lane: scene computation across the full recording within a pinned time budget.
- The Playwright spectate journey above, in CI.

## Done when

The tactical card appears on the home page with its thumbnail, a live naive-vs-naive skirmish and an army match are watchable in the web app at the 150 ms cadence, replay seeks land on identical frames, and `npm run play -- tactical_game` runs a rendered local match in watch mode. The shared conformance suite, the scene tests, the perf smoke, the docs lane, and the spectate journey are green.
