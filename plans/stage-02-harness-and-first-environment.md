# Stage 2: Harness and the First Environment

Status: in progress. The Python vertical slice is built and green locally — the environments package, the session harness, the agent interface and manifest loader, the CLI, the real template content, the hello heuristic agent, and the docs all land in this change set, with `scripts/ci.py` passing `python`, `typescript`, `examples`, `docs`, and `publish-dry-run` (`generated-code-fresh` passes once the regenerated files are committed). What remains is the outward-facing release: running the `template-publish` workflow for version 1 and stamping `template-v1` on the monorepo (build-order step 8), which is a deliberate, separately triggered action.

## Goal

A complete Python-side vertical slice with no server involved: the session harness steps the single-agent Flappy Bird environment with either a scripted agent or a supplied human/noop action source, emits schema-valid per-step states, and writes a replayable recording to disk. The participant template repo exists and works against vanilla PettingZoo.

## Plan documents

The detailed design lives under [stage-02/](stage-02/):

- [environments-and-metadata.md](stage-02/environments-and-metadata.md): the environments package, the single-agent compatibility wrapper, Flappy Bird and its overlay, the public metadata layer and registry.
- [agent-interface-and-manifest.md](stage-02/agent-interface-and-manifest.md): the agent ABC, duck-typed optional hooks, the manifest format and loader.
- [session-harness.md](stage-02/session-harness.md): the session loop, the injectable clock, action sources, timeout machinery, state assembly, the CLI.
- [template-and-examples.md](stage-02/template-and-examples.md): the real template content, the synced environment code, dependency set v1, the hello example, cutting `template-v1`.
- [testing-ci-and-docs.md](stage-02/testing-ci-and-docs.md): the test suites that encode the exit criteria, CI and tooling wiring, the docs pages that stop being stubs.

## Scope

Bring in the Flappy Bird style game (the `flappy-bird-gymnasium` package) behind a small in-house, general-purpose Gymnasium-to-PettingZoo compatibility wrapper, so the harness only ever sees a PettingZoo interface, per [environment.md](../specs/environment.md). The wrapper must accept a seed on reset and expose one slot that can be controlled by either an agent or a human action source.

Implement the public-facing metadata layer as a declarative structure each environment registers alongside its PettingZoo entry point: display name, description, slot counts, human-capable slots, recommended episode length, pace interval (set for realtime environments, null for turn-based), default per-step and per-episode time limits, default human-slot timeout for live sessions, messaging flag and cap, LLM flag, and the renderer reference. The backend will later serve this to the frontend, so it must be serializable.

Define the agent interface from [submission.md](../specs/submission.md) as an abstract base class: `reset(seed)`, `act(observation)`, optional `learn(observation, action, reward, terminated)`, optional `chat(inbox)`. The harness detects the optional hooks by presence. In this stage `chat` is defined but never called; the harness gains chat routing in Stage 9.

Implement the single session harness loop from [interaction.md](../specs/interaction.md): seeded reset, sequential stepping of each slot, per-step state assembly with the overlay fields Flappy Bird needs (pipe positions and the like), wall-clock timing per decision, per-step and per-episode timeout enforcement, and recording through the Stage 1 save interface. The clock source must be injectable so deterministic tests can compare recordings without real wall-clock noise. There is one loop, not a realtime one and a turn-based one: each step asks the acting slot for an action under a deadline and applies an environment-provided default action if the deadline passes. The realtime-versus-turn-based difference is the environment's pace interval, and wall-clock pacing of that interval is a live-session concern layered on in Stage 3; the harness loop structure is identical either way, and the local CLI simply steps as fast as it can. The loop should already treat "human" as a slot implementation fed by external actions, even though the local CLI may default to scripted or noop actions. Human-controlled slots have their own timeout configuration, separate from agent timeouts, and the harness API accepts a default action provider for when that timeout expires. For Flappy Bird this is just noop, but the API should be general enough for a later turn-based environment to provide a legal default move. The harness exposes a programmatic API that Stage 3 drives from inside the container, plus a local CLI runner for development.

Define the manifest format from [submission.md](../specs/submission.md): entry-point module, agent class name, and the template dependency-set version the repo targets. The harness loads an agent from a manifest, which is exactly what the session container will do.

Build the template repo under `templates/`: interface stubs including `chat`, a filled-in manifest, the pinned dependency set (a fully pinned list of everything an agent may import; each template release versions the set, and that version is what manifests and base images refer to), the compatibility wrapper and Flappy Bird environment needed locally (synced from `environments/` by the generate script, under the staleness check), a local play script, a simple evaluation harness, a minimal LLM API example reading `OPENAI_BASE_URL` and `OPENAI_API_KEY` from a `.env` file, and a README. The publishing mechanism is built in Stage 1 (see [examples-and-template-publishing.md](stage-01/examples-and-template-publishing.md)): the template is published to a separate student-facing repository by a manually dispatched workflow that takes the dependency-set version as input, publishes the composed artifacts, then stamps `template-v<N>` on the monorepo as its last step. Stage 2 replaces the Stage 1 placeholder with the real template content and cuts `template-v1`.

## Spec references

[environment.md](../specs/environment.md), [submission.md](../specs/submission.md) (agent interface, packaging, template repos), [interaction.md](../specs/interaction.md) (state object contents), [recording.md](../specs/recording.md).

## Depends on

Stage 1 (schema, validation, recording format).

## Done when

A scripted agent loaded from a manifest plays a full seeded Flappy Bird episode through the harness CLI; the same seed twice produces identical recordings when run with a deterministic test clock; a deliberately slow agent trips the per-step timeout; a human/noop action source can drive the same single slot through the programmatic API; the human-slot timeout path falls back to noop without using the agent timeout machinery; and the template repo's local play script runs an episode on a clean machine with no sandbox backend present.

Additionally for the release: the `template-publish` workflow runs for version 1, replacing the placeholder in the student repository with the real template and the real hello example, and stamps `template-v1` on the monorepo.

## Build order

1. The `environments/` package: workspace membership, the `GymnasiumToAEC` adapter validated by PettingZoo's `api_test`, the Flappy Bird factory and overlay extractor, environment-level determinism tests.
2. Metadata types in the harness (`EnvironmentMeta`, `EnvironmentEntry`), the Flappy Bird `ENTRY` with its proposed metadata values, entry-point registration and discovery.
3. The agent ABC, hook detection, the manifest format and loader, with their tests. Can run in parallel with 1 and 2.
4. The session loop: clock protocol, slot bindings and action sources, timeout machinery, state assembly through the Stage 1 store, `EpisodeResult`; the `learn_ms` additive schema change through the generate script; the determinism, timeout, and external-slot tests.
5. The CLI over `run_episode`, plus the cross-package CLI smoke test.
6. The real template content: stubs, manifest, synced `sandbox_env/` via the generate script, play and evaluate scripts, the LLM example, dependency set v1 compiled from `requirements.in`, the rewritten hello example. Can start once 1 is done.
7. Docs: the two student pages, the contributor environments page, the environments README pointer.
8. Run the publish workflow for version 1; verify the student repository end to end.
9. Keep this file and the stage-02 documents in sync with whatever the implementation confirms or changes, per the [plan rules](README.md).

## Open questions

Flappy Bird's pace interval is proposed at 50 ms but can only be tuned honestly with a renderer under real input, so the value is confirmed during Stage 4 playtesting; the metadata field is trivial to change. The overlay extractor depends on `flappy-bird-gymnasium` internals at the pinned 0.4.0; if those internals prove unusable at implementation time, the documented escalation is vendoring a minimal Flappy Bird implementation into the environments package. Per-episode budget semantics across multiple slots are deliberately left to Stage 8, when a second, multi-slot environment makes the question concrete.

## Resolved at implementation time

The `flappy-bird-gymnasium==0.4.0` internals proved usable directly (no vendoring needed): the overlay reads `gym_env.unwrapped`'s `_player_*`, `_upper_pipes`/`_lower_pipes`, `_score`, and the screen dimensions, all covered by the finite-field test. The dependency set v1 was compiled with `uv pip compile templates/base/requirements.in -o templates/base/requirements.txt --python-version 3.12`; it resolves `pettingzoo==1.26.1`, `gymnasium==1.3.0`, `numpy==2.4.6`, `pygame==2.6.1`, plus `openai`, `python-dotenv`, and their transitive closure. The environments package pins are kept in step with that set (`pettingzoo>=1.26,<1.27`). All proposed Flappy Bird metadata values were adopted as-is. The overlay carries the screen `width`/`height` on every step rather than only the first, so each frame is self-describing for the renderer (a few bytes; harmless). `run_episode` gained a `max_steps` parameter backing the CLI's `--steps` cap, and the synced environment modules use relative/third-party imports so the generate step copies them verbatim into `templates/flappy_bird/sandbox_env/` and writes only the two `sandbox_env` `__init__` files (the top-level one exposing the uniform `make_env`/`ENV_ID`/`PLAYER_SLOT` surface).
