# Implementation Plan

This folder is the implementation-level plan for Game Sandbox. The specification under [specs/](../specs/README.md) describes what the system is; these plans describe how and in what order we build it. Read the spec first, then the stage you are about to work on.

## How the plan stays connected to the implementation

The plan is a living document, not a launch checklist. Every piece of implementation work must stay connected to its stage file:

- Before starting work on a stage, read its file and confirm it still matches reality. Update the status line when work begins and when it ends.
- When the implementation deviates from what the stage file says (a different library, a changed interface, a re-scoped deliverable, work moved between stages), revise the stage file in the same change set as the code. The plan must never describe a system that was not built.
- If a deviation contradicts the specification itself, the spec is the higher authority on intent: either bring the implementation back in line, or revise the spec deliberately and update the plan to follow. Never let code, plan, and spec say three different things.

A pull request that changes behavior planned here and does not touch the corresponding stage file is incomplete.

## Stage overview

The stages are ordered by dependency. Each stage produces something that runs and can be exercised end to end, so progress is always demonstrable. Later stages assume earlier ones are done, but the optional capabilities (communication, LLM) are deliberately late and independent of each other.

1. [Stage 1: Contracts and repo skeleton](stage-01-contracts.md). The monorepo layout, the versioned per-step state JSON Schema, type generation for TypeScript, validation for Python, and the recording file format. The wire format is the contract everything else builds against, so it comes first.
2. [Stage 2: Harness and the first environment](stage-02-harness-and-first-environment.md). The Python session harness, the Flappy Bird environment through Shimmy, the agent interface, the public-facing metadata layer, a local runner, recordings written to disk, and the participant template repo.
3. [Stage 3: Backend and live sessions](stage-03-backend-and-live-sessions.md). The Node/TypeScript backend, Docker orchestration of one sandboxed container per session, the WebSocket bridge between container and browser, and session lifecycle limits.
4. [Stage 4: Frontend core](stage-04-frontend-core.md). GitHub OAuth, the home and environment pages, the Flappy Bird renderer with human input, live play for allowlisted users, the replay viewer, and recording retention.
5. [Stage 5: Submissions](stage-05-submissions.md). The submission form and rules, repo and commit verification, the manifest-driven image build pipeline, and agent profile pages.
6. [Stage 6: Iterations and leaderboards](stage-06-leaderboards.md). Iteration configuration and CLI, the sequential automated workflow with seeded repetitions and timing, the automated board, ratings collection, and the human-feedback board.
7. [Stage 7: Agent communication](stage-07-communication.md). The chat hook in the harness, message routing and limits, the chat panel in the renderer, and messages in recordings and replays.
8. [Stage 8: LLM gateway](stage-08-llm-gateway.md). The gateway service, the internal-only network, one-off session keys, telemetry sidecars, budgets, the owner debug view, and token columns on the automated board.
9. [Stage 9: Multi-agent](stage-09-multi-agent.md). The first multi-agent environment, the turn-based session loop in practice, the watch multi-agent flow, and multi-submission session images.

## Conventions for stage files

Each stage file carries a status line (not started, in progress, done), the goal, the scope of what gets built, the spec files it implements, explicit dependencies on earlier stages, exit criteria that say when the stage is done, and a Deviations section that starts empty and accumulates the differences between plan and implementation as described above.

Decisions that the spec leaves open (frameworks, storage engines, exact module layout) are proposed in the stage files as defaults. Confirm or replace them when the stage starts, and record the choice in the stage file either way.
