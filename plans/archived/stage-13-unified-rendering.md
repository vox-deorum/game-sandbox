# Stage 13: Unified browser rendering

Status: completed. Browser-only rendering, maximum reuse of the production harness, the credited pygame-free Flappy Bird adaptation, no backward compatibility work, and no `template_version` bump are implemented while the repository remains unreleased.

## Goal

The PixiJS browser renderers become the only renderers maintained by Game Sandbox. Local play uses the production live runner and the browser protocol through a loopback-only Python bridge, so maintainers and students exercise the same stepping, timeout, agent-loading, recording, and state code used by Docker sessions.

The repository and every composed student environment have no pygame dependency. Flappy Bird keeps its current dynamics and public contract through a small, MIT-licensed adaptation of the non-rendering logic from `flappy-bird-gymnasium` 0.4.0. No upstream sprites, audio, models, LIDAR code, or renderer code are copied.

## Scope

- Delete the custom pygame renderers, human controllers, demos, and their tests.
- Replace `flappy-bird-gymnasium` with a credited, pygame-free local simulation core.
- Make the harness relocatable under `sandbox.harness` and add environment injection seams.
- Add a loopback HTTP and WebSocket bridge around the existing live runner.
- Add a local frontend entry that reuses the production renderer, socket, and UI components.
- Ship the relocated harness in tracked template sources and inject the prebuilt local frontend only while staging student repositories for publication.
- Keep production stepping and the browser state schema unchanged. Both relays gain pause-state replay on attach so the shared socket has an authoritative state after reconnect.

Unity ML-Agents, browser execution of participant code, production HTTP routes, and a general-purpose local web server remain out of scope.

## Related specifications

- [Interaction](../docs/specs/interaction.md): browser rendering, human input, environment-specific overlays, and session pacing.
- [Environments](../docs/specs/environment.md): PettingZoo behavior, metadata, and determinism.
- [Execution](../docs/specs/execution.md): the live runner and its ordered JSON-lines channel.
- [Recording](../docs/specs/recording.md): the header and state stream shared by live play and replay.
- [Frontend](../docs/specs/frontend.md): the renderer host and shared UI behavior.

## Depends on

- [Stage 3](stage-03-backend-and-live-sessions.md): live runner, relay protocol, and attach semantics.
- [Stage 4](stage-04-frontend-core.md): browser renderers, session socket, and replay-compatible states.
- [Stage 7](stage-07-multi-agent.md) and [Stage 8](stage-08-communication.md): multi-seat play and chat.
- [Stage 11](stage-11-semantic-contract.md): the student observation and action contracts.

## Design decisions

### One renderer per environment

Production sessions already use the required pipeline:

```text
live runner JSONL <-> relay <-> browser SessionSocket <-> PixiJS renderer
```

Local play uses the same pipeline. A Python relay replaces the Node relay, and a local page replaces the authenticated application shell. The environment continues to emit semantic observations and renderer overlays. It never renders pixels server-side.

### Pygame-free Flappy Bird adaptation

`environments/flappy_bird/game.py` becomes a small Gymnasium environment adapted from the non-rendering game logic in `flappy-bird-gymnasium` 0.4.0. It preserves the current action values, screen and collision dimensions, gravity, flap impulse, rotation, pipe movement and recycling, seeded pipe generation, rewards, score-limit truncation, and terminal behavior. Axis-aligned numeric collision checks preserve pygame `Rect.colliderect` edge behavior without importing pygame.

The adapted core exposes a public immutable state snapshot used by both `FlappyBirdEnv.observe()` and `extract_overlay()`. This removes the current dependency on private third-party fields. `env.py` constructs the core directly and retains the shared `GymnasiumToAEC` adapter. The core has no render mode, assets, audio, LIDAR, model files, matplotlib, or package-registration side effect.

Provenance is part of the shipped source:

- Each adapted source file keeps the applicable upstream copyright and MIT permission header, names `https://github.com/markub3327/flappy-bird-gymnasium`, and identifies version 0.4.0 as its source.
- `environments/flappy_bird/UPSTREAM_LICENSE.md` records the provenance and carries the complete upstream MIT license text, including the Gabriel Nogueira and Martin Kubovcik notices. It also preserves the upstream acknowledgements of Talendar's `flappy-bird-gym` and sourabhv's `FlapPyBird` work.
- The license file and adapted modules are included in the environment wheel and in the generated student template. The upstream sprites, audio, and models are not copied.

Before removing the package, generate a committed golden trace from 0.4.0 for several fixed seeds and action scripts. The trace covers reset, ordinary flight, ceiling reward, scoring, pipe recycling, ground and pipe crashes, and score-limit truncation. Each frame records the semantic observation, overlay, reward, termination, truncation, score, and pipe state. The adapted core must reproduce the trace, and direct collision tests pin edge-touch and one-pixel-overlap behavior.

### Relocatable and injectable harness

The harness remains `game_sandbox_harness` in the monorepo and is copied to `sandbox.harness` in a student repository.

- Convert every internal absolute import to a relative import.
- Make schema resources package-relative. `schema.py` resolves `schema_data` below `__package__` and never names `game_sandbox_harness.schema_data` literally.
- Extract `live.run(entry, config, *, protocol, control, clock, sleeper, store)`. `main()` performs stdout claiming, parsing, environment discovery, and dependency construction, then calls `run`. The template shim constructs `EnvironmentEntry` from `sandbox.env` and calls the same function.
- Add `start_paused` to `LiveConfig`. The runner emits the header and opening state, then waits for a `resume` command before the first step.
- Require the complete resolved `parameters` map in `LiveConfig`. `Episode` defensively re-resolves it, calls `entry.make(parameters)`, verifies the environment's agent count matches `parameters["seats"]`, and records the normalized map in the header.
- Give `human_timeout_ms` three wire states: an omitted field uses environment metadata, an integer is an override, and JSON `null` disables the turn-based timeout. Realtime environments continue to use their pace interval as the input deadline.
- Require `players` in every new live configuration. Its keys exactly equal `slots`; `external` slots are `human`, agent slots are `agent`, and every attribution has a nonempty label. The local launcher builds this map from the selected human seat and agent bindings, so `header.players` is always the authority for browser controls.
- Local play passes a caller-owned scratch recording directory to the existing tee store. Streaming and recording continue to share the one `Episode._record_step` path.
- Local configurations set `llm=None`, pass explicit agent paths, and make no network calls.

The relocated-package tests import `sandbox.harness.schema`, load both packaged schemas, validate a fixture, and then exercise the local shim. This catches both Python import and package-data mistakes.

### Local relay and server

Add `game_sandbox_harness/local_server.py` using `websockets>=16,<17`; the lock and compiled template requirements pin the resolved version. The server spawns a caller-supplied live-runner command, pumps child output, and forwards validated commands to child stdin.

The bridge owns relay behavior while leaving recording and result payloads authoritative:

- Recording header, state, and result bytes from the runner pass through unchanged.
- The first header moves the relay to running and emits a session envelope whose `awaiting_start` field says whether the first resume is still required. When the launch starts paused, the relay immediately follows that status with the current `pause` echo for clients that attached before the header arrived.
- Accepted `pause` and `resume` commands are forwarded and echoed to every connected client.
- Both relays retain the accepted pause and awaiting-Start state. Local modes start paused from their launch configuration, while the Node relay starts human sessions paused and scripted watch sessions running. The first accepted resume clears awaiting-Start. An attachment receives that state in its running envelope and a `pause` echo when currently paused, so refresh cannot turn a later pause back into a Start gate.
- A terminal result or child exit emits exactly one `session: ended` envelope with the resolved reason, then closes attached sockets.
- Attach order is header, latest state, current session status, then the current pause echo when paused. Reconnect and a second tab receive a header first, as `SessionSocket` requires. Apply the same pause-state tracking and attach replay to `backend/src/session/live-session.ts` so both relays honor the existing `useSessionSocket` contract.

Factor the Python inbound command parser out of `SessionControl` so the bridge and child share command shape validation. Lifecycle-envelope construction also lives in one Python helper. The bridge does not reimplement recording schemas, step-state construction, action validation, pacing, or episode logic.

The WebSocket route is `/api/sessions/local/ws`. HTTP serves `local.html`, hashed assets, and `GET /api/environments`, whose response is the one-element array `[META]`. The generated `META` is the complete `EnvironmentMeta.to_json()` value, with all fields preserved, so the page uses the existing `getEnvironments()` validation and shared `EnvironmentMeta` type.

Security boundaries are explicit:

- Bind only to `127.0.0.1`; the CLI exposes no wildcard or non-loopback host option.
- Resolve the static root once. Reject absolute paths, `..`, encoded traversal, symlink escapes, directories, and non-regular files whose resolved path is outside that root.
- Route only GET and HEAD assets, `GET /api/environments`, and the one WebSocket path. Unsupported methods and paths receive a non-success response.
- Serve correct content types and lengths, support HEAD, disable caching, and add no server pacing.

### Student template and command entry points

`scripts/compose.py` generates the harness from `harness/src/game_sandbox_harness/`, including `schema_data`, into each fresh build output. It does not write generated harness files into template source.

`scripts/publish_template.py` builds `frontend/dist-local/` once for a release or dry run, then injects that directory as `sandbox/web/` into every staged template and example. `sandbox/web/` is absent from tracked sources and exists only in build and publish staging output.

Compose writes generated base helpers into a fresh build directory, so no owned-directory wipe or retired-generated-path list is needed. The freshness job checks only committed generated schema, fixture, metadata, and packaging outputs. Compose and example tests verify the generated harness, environment package, helpers, and staged web directory.

The generated `sandbox.env.META` is the full registry metadata, with declared `EnvParameter` and `EnvParameterChoice` constructors preserved and synthesized `seats` left to `EnvironmentMeta.to_json()`. `templates/base/sandbox/live_local.py` constructs the environment entry, resolves pure defaults, and invokes the relocated runner. `sandbox/evaluate.py` uses the same resolved defaults through a small headless harness helper, so evaluation and server execution share parameter, timeout, and default-action behavior.

Add `flappy_bird/game.py` and `flappy_bird/UPSTREAM_LICENSE.md` to the Flappy `TemplateEnvironmentSpec.modules` list, remove `human.py`, and make wheel inclusion explicit. A generation and composition test asserts that both credited source files reach the student repository and that none of the upstream binary asset directories do.

`templates/base/sandbox/play.py` becomes the generic CLI for every game. It parses seed, step limit, mode, player, rival, port, and browser options; constructs complete `slots` and `players` maps; launches the local server; and opens the browser. Hearts and Spades no longer override it. The runtime probe includes `jsonschema` and `websockets`. `python -m sandbox eval` remains the headless command.

`scripts/play.py` uses the same bridge, live runner, registry, and manifest loading, serving `frontend/dist-local/`. It rebuilds the local bundle before every play launch so frontend changes are always present.

### Local frontend entry

Add `frontend/local.html`, `frontend/src/local/main.ts`, and `frontend/src/local/LocalPlayPage.vue`. The entry imports the production global styles and has no router, authentication, or account provider. It:

- loads the single metadata entry through the shared environment catalog client;
- connects `useSessionSocket("local", ...)`, using `live_interval_ms` for turn-based human play;
- mounts through `useRendererMount` and derives controlled slots from human entries in `header.players`;
- reuses `StageFrame`, `GameOverCard`, `DecisionLog`, display-only `ChatPanel`, and UI primitives;
- reuses the shared game-view start overlay and socket start state, sends `resume` from that overlay, drives later pause controls from relay echoes, and drives stop from terminal session status.

The pause control is driven by pause and resume echoes. Stop sends the existing `stop` command and enters its terminal UI state only when the result and `session: ended` frames arrive; there is no stop echo in the protocol.

A second Vite config builds only `local.html` to `frontend/dist-local/`. The production build does not contain the local entry. The implementation first audits reused components for router, account, injection, and production-API assumptions, and records every new primitive variant on `/styleguide`.

## Deletions and dependency updates

- Delete `environments/local_play/{render_base,render_cards,hidpi,multiseat_play}.py`; keep the card rules, spaces, and semantic helpers.
- Delete Hearts and Spades `render.py`, `human.py`, and `demo.py`, plus Flappy Bird `human.py`.
- Remove custom render plumbing and `render_modes` from Hearts and Spades. Their `render()` methods remain harmless `None` returns for the PettingZoo shape. The new Flappy core publishes no renderer.
- Delete per-game template play overrides, renderer tests, hit-test tests, and pygame import pins.
- Remove `flappy-bird-gymnasium` and direct `pygame` requirements from `environments/pyproject.toml` and `templates/base/requirements.in`. Add `jsonschema` and `websockets` to the template intent and `websockets` to the harness dependency set.
- Recompile `templates/base/requirements.txt`, refresh `uv.lock`, and regenerate `backend/images/session-base/deps-v1/requirements.txt` in place. The resolved dependency closure contains none of `pygame`, `flappy-bird-gymnasium`, or its unused `matplotlib` dependency.
- Keep `template_version` and every `deps-v1` registry touchpoint at 1.

Version 1 has not been published. Update the dependency-version comments and contributor contract in the same change: an active, unreleased `deps-v<N>` directory may be regenerated with its matching template; the snapshot becomes immutable when `template-v<N>` is published. This records why changing `deps-v1` in place is valid here while preserving immutability for released dependency sets.

## Tests

- Harness relocation: both package names load schema resources and validate fixtures.
- Live configuration: timeout tri-state, `start_paused`, and exact `slots` to `players` attribution.
- Local server: loopback default, route and method rejection, traversal and symlink escape rejection, content type and HEAD behavior, header-first ordering, verbatim runner lines, running/ended exactly once, awaiting-Start and pause/resume echoes, paused reconnect state, command forwarding, second attachment, and child failure.
- Integrated harness: a real Hearts episode runs through injected `live.run` without discovery.
- Template smoke: composed examples import the relocated harness and run `sandbox.live_local` without a browser.
- Publish staging: a dry run builds the local frontend once and gives every staged template and example a complete `sandbox/web/` directory containing `local.html` and its referenced assets.
- Flappy Bird: upstream golden traces, API conformance, seeded determinism, observation and overlay shape, AABB boundary behavior, and absence of copied upstream binary assets.
- Frontend unit test: metadata validation, header mounting, controlled human seat, state rendering, the shared game-view Start overlay, start resume, pause echo, paused reconnect, stop awaiting terminal status, and terminal game-over state.
- Playwright local-play journey: rebuild both frontend entries, start a scripted Python bridge on loopback with the fresh local bundle, then exercise start, input forwarding, pause, resume, refresh while paused, stop, terminal game over, and browser reconnect against the live DOM. Run it through the existing `frontend-e2e` job.
- Existing session and replay tests remain unchanged unless a shared component contract moves.

## Risks

- Flappy Bird behavior may drift when pygame collision helpers are removed. Golden traces are captured before dependency deletion, and direct geometry tests cover the boundary cases traces may miss.
- Harness relocation touches production imports and schema loading. It lands as a behavior-neutral step and must pass both package-name test paths before the local bridge is added.
- The local Vite bundle has hashed output. The lockfile pins the toolchain, publication builds it once and owns each staged `sandbox/web/` directory, and no exported bundle is tracked in the template source tree.
- Copying the harness into student repositories exposes implementation internals. Student docs keep `sandbox.env` and the helper modules as the supported authoring surface.
- `websockets` major APIs change over time. The dependency stays within major version 16, and bridge tests pin the HTTP and WebSocket behavior the implementation relies on.

## Documentation and plan updates

Update the specifications alongside implementation:

- Revise [Execution](../docs/specs/execution.md) to describe the loopback-only Python relay and assign its local relay responsibilities in the implementation-languages table.
- Revise [Interaction](../docs/specs/interaction.md) to define local browser play and how its input, pause, pacing, and shared session controls follow the browser interaction contract.

Revise the contributor environment, rendering, execution, template, design, and development-setup guides. Revise student getting-started and the canonical `environments/<env>/environment.md` guides to describe browser local play. MkDocs publishes those files directly at their virtual website paths. The Flappy Bird contributor and student docs credit the upstream 0.4.0 simulation and point to the shipped MIT notice without implying that upstream art is included.

Update completed plan text that describes the removed renderers or third-party Flappy package as current architecture. This includes Stage 2, the Stage 3 pygame-banner notes, Stage 7 local play, Stage 8 local play, and Stage 11 template contracts. Keep historical decisions only where they still explain current code.

## Implementation order

1. Capture upstream Flappy golden traces, add the credited local core, switch the wrapper and overlay, and remove the upstream dependency after parity passes.
2. Make the harness imports and resources relocatable; add entry injection, timeout, pause, attribution, and shared command-parser seams while existing production tests remain green.
3. Build the loopback bridge and its safety, lifecycle, attach, and integrated-runner tests.
4. Build the local frontend entry, Vite config, unit tests, and local Playwright journey.
5. Rewrite the maintainer play command on the bridge and verify it against the prebuilt local bundle.
6. Add compose-time harness and helper generation, publish-time bundle staging, full metadata, template shims, generic play and evaluation commands, and template smoke tests.
7. Delete custom pygame sources and dead tests, then update dependencies, generated outputs, docs, completed plans, and comments.

## Exit criteria

- The Python and example dependency closures contain no `pygame`, `flappy-bird-gymnasium`, or `matplotlib` introduced by that package.
- Fixed Flappy seeds and action scripts reproduce the committed upstream 0.4.0 golden behavior.
- `npm run play -- hearts human` and `npm run play -- flappy_bird human` open loopback browser play; start, input, pause, resume, refresh, stop, and game over work.
- A composed template runs `python -m sandbox play` fully offline and `python -m sandbox eval` headless.
- Publish dry runs and releases build the local frontend once and inject it into every staged template and example, while tracked template sources contain no exported browser bundle.
- Server and local play emit structurally identical header, state, and result lines for the same environment configuration and seed.
- Mid-game reconnect receives header, latest state, running status, and the current pause state; terminal status appears exactly once.
- The local server is loopback-only by default and rejects filesystem escape attempts.
- `uv run ruff check --fix .` and `uv run ruff format .` have been applied after Python changes.
- `uv run python scripts/ci.py python`, `generated-code-fresh`, `examples`, frontend unit/build checks, and `uv run python scripts/ci.py frontend-e2e` pass.
- Manual Flappy play holds the 50 ms input cadence, and Hearts plays opponents at `live_interval_ms`.
- `scripts/bump_template_version.py --check` confirms every version touchpoint remains at 1.
