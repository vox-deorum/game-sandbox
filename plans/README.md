# Implementation Plan

This folder is the implementation-level plan for Game Sandbox. The specification under [docs/specs/](../docs/specs/README.md) describes what the system is; these plans describe how and in what order we build it. Read the spec first, then the stage you are about to work on.

## How the plan stays connected to the implementation

The plan is a living document, not a launch checklist. Every piece of implementation work must stay connected to its stage file:

- Before starting work on a stage, read its file and confirm it still matches reality. Update the status line when work begins and when it ends.
- When the implementation changes what a stage file says (a different library, a changed interface, a re-scoped deliverable, work moved between stages), revise the stage file itself in the same change set as the code. Do not keep a separate change log for plan mismatches. The plan is the current intended build path, and it must never describe a system that was not built.
- If a plan change would contradict the specification itself, the spec is the higher authority on intent: either bring the implementation back in line, or revise the spec deliberately and update the plan to follow. Never let code, plan, and spec say three different things.

A pull request that changes behavior planned here and does not touch the corresponding stage file is incomplete.

## Stage overview

The stages are ordered by dependency. Each stage produces something that runs and can be exercised end to end, so progress is always demonstrable. Later stages assume earlier ones are done, but the optional capabilities (LLM, communication) are deliberately late and independent of each other. Communication comes right after multi-agent on purpose: it uses the multi-agent environment from Stage 7 (Hearts) as the test bed where broadcast-versus-targeted visibility actually matters, instead of standing up a throwaway multi-slot environment of its own. The LLM gateway is independent of both and comes last.

1. [Stage 1: Contracts and repo skeleton](stage-01-contracts.md). The monorepo layout, the versioned per-step state JSON Schema, type generation for TypeScript, validation for Python, the recording file format, and the shared versioning rules for later sidecars. The wire format is the contract everything else builds against, so it comes first.
2. [Stage 2: Harness and the first environment](stage-02-harness-and-first-environment.md). The Python session harness, the Flappy Bird environment behind a thin PettingZoo compatibility wrapper, the agent interface, the public-facing metadata layer, a local runner, recordings written to disk, and the participant template repo. This stage proves one slot first.
3. [Stage 3: Backend and live sessions](stage-03-backend-and-live-sessions.md). The Node/TypeScript backend, the execution driver interface with local Docker as its first implementation, one sandboxed container per session, the WebSocket bridge between container and browser, and session lifecycle limits. The first live sessions can be either human-controlled Flappy Bird runs or scripted-agent runs.
4. [Stage 4: Frontend core](stage-04-frontend-core.md). The home and environment pages, the Flappy Bird renderer with human input, live play for allowlisted users, the replay viewer, and recording retention. Identity is a single auto-logged-on mock user; GitHub OAuth is deferred as future work behind the same identity seam. [Stage 4.5: UI restructure](stage-04.5-ui-restructure.md) follows before submissions: the token-based design system and component primitives, the rethought navigation with visible placeholders for the sections later stages add, written design principles, and the refactor of the Stage 4 pages onto all of it.
5. [Stage 5: Submissions](stage-05-submissions.md). The submission form and rules, repo and commit verification, the code-overlay build onto versioned base images, watch runs for submitted single-agent agents, and agent profile pages. A minimal current iteration record exists here only so submissions have somewhere to attach.
6. [Stage 6: Iterations and leaderboards](stage-06-leaderboards.md). Full iteration configuration through an operator admin console (declare, configure the match design, open/close submissions, open/close public play and feedback, trigger and re-run the workflow with live logs, release/unrelease results) backed by an operator-only admin HTTP API, the balanced schedule generator, the sequential automated workflow with seeded repetitions and timing, the automated board, ratings collection, and the human-feedback board. This stage deliberately revises [leaderboard.md](../docs/specs/leaderboard.md) and [frontend.md](../docs/specs/frontend.md) away from the original configuration-file-and-CLI model toward the admin UI.
7. [Stage 7: Multi-agent](stage-07-multi-agent.md). The first multi-agent environment (Hearts), the unpaced multi-slot session loop in practice, the watch multi-agent flow, and multi-submission sessions. Hearts ships here without messaging; Stage 8 lights chat up on it.
8. [Stage 8: Agent communication](stage-08-communication.md). The chat hook in the harness, message routing and limits, the chat panel in the renderer, and messages in recordings and replays. It comes right after multi-agent so Hearts is already there as its test bed.
9. [Stage 9: LLM gateway](stage-09-llm-gateway.md). The gateway service, the internal-only network, one-off slot keys for each session, telemetry sidecars, budgets, the owner debug view, and token columns on the automated board.

## Conventions for stage files

Each stage file carries a status line (not started, in progress, done), the goal, the scope of what gets built, the spec files it implements, explicit dependencies on earlier stages, and exit criteria that say when the stage is done. Keep those sections current by editing the plan text directly as implementation choices are confirmed.

Decisions that the spec leaves open (frameworks, storage engines, exact module layout) are proposed in the stage files as defaults. Confirm or replace them when the stage starts, and record the choice in the stage file either way.
