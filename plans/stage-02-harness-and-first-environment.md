# Stage 2: Harness and the First Environment

Status: not started

## Goal

A complete Python-side vertical slice with no server involved: the session harness steps the single-agent Flappy Bird environment with either a scripted agent or a supplied human/noop action source, emits schema-valid per-step states, and writes a replayable recording to disk. The participant template repo exists and works against vanilla PettingZoo.

## Scope

Bring in the Flappy Bird style game through Shimmy so the harness only ever sees a PettingZoo interface, per [environment.md](../specs/environment.md). The wrapper must accept a seed on reset and expose one slot that can be controlled by either an agent or a human action source.

Implement the public-facing metadata layer as a declarative structure each environment registers alongside its PettingZoo entry point: display name, description, slot counts, human-capable slots, recommended episode length, tick rate for realtime environments, default per-step and per-episode time limits, default human-slot timeout for live sessions, messaging flag and cap, LLM flag, and the renderer reference. The backend will later serve this to the frontend, so it must be serializable.

Define the agent interface from [submission.md](../specs/submission.md) as an abstract base class: `reset(seed)`, `act(observation)`, optional `learn(observation, action, reward, terminated)`, optional `chat(inbox)`. The harness detects the optional hooks by presence. In this stage `chat` is defined but never called; the harness gains chat routing in Stage 7.

Implement the session harness loop: seeded reset, sequential stepping of each slot, per-step state assembly with the overlay fields Flappy Bird needs (pipe positions and the like), wall-clock timing per decision, per-step and per-episode timeout enforcement, and recording through the Stage 1 save interface. The loop should already treat "human" as a slot implementation fed by external actions, even though the local CLI may default to scripted or noop actions. Human-controlled slots have their own timeout configuration, separate from agent timeouts, and the harness API accepts a default action provider for when that timeout expires. For Flappy Bird this is just noop, but the API should be general enough for a later turn-based environment to provide a legal default move. The harness exposes a programmatic API that Stage 3 drives from inside the container, plus a local CLI runner for development.

Define the manifest format from [submission.md](../specs/submission.md): entry-point module, agent class name, and the template dependency-set version the repo targets. The harness loads an agent from a manifest, which is exactly what the session container will do.

Build the template repo under `templates/`: interface stubs including `chat`, a filled-in manifest, the pinned dependency set (a fully pinned list of everything an agent may import; each template release versions the set, and that version is what manifests and base images refer to), the Shimmy wrapper needed locally, a local play script, a simple evaluation harness, a minimal LLM API example reading `OPENAI_BASE_URL` and `OPENAI_API_KEY` from a `.env` file, and a README. Decide at stage start whether the template is published as a separate repo generated from `templates/` or used in place, and how releases are cut (a git tag per dependency-set version is the proposed default).

## Spec references

[environment.md](../specs/environment.md), [submission.md](../specs/submission.md) (agent interface, packaging, template repos), [interaction.md](../specs/interaction.md) (state object contents), [recording.md](../specs/recording.md).

## Depends on

Stage 1 (schema, validation, recording format).

## Done when

A scripted agent loaded from a manifest plays a full seeded Flappy Bird episode through the harness CLI; the same seed twice produces identical recordings; a deliberately slow agent trips the per-step timeout; a human/noop action source can drive the same single slot through the programmatic API; the human-slot timeout path falls back to noop without using the agent timeout machinery; and the template repo's local play script runs an episode on a clean machine with no sandbox backend present.

## Deviations

None yet.
