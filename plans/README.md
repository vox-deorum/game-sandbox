# Implementation Plan

The [specification](../docs/specs/index.md) defines the system. This folder tracks how it is built, in dependency order.

The plan is a living description of the current intended build path, not a change log or a launch checklist. Edit a stage directly when implementation decisions change so the plan never describes work that was not built.

```text
Specification → stage overview → stage plan → implementation and tests
       ↑                                             │
       └──────── update together when intent changes ┘
```

## Keep plans current

1. Read the relevant specification and stage file before implementation.
2. Update the stage status when work starts and finishes.
3. Revise the stage file in the same change when an implementation choice, interface, library, scope, or stage boundary changes.
4. If code and specification disagree, either restore the code to the specification or deliberately revise the specification and plan together.

A pull request that changes behavior planned here without touching the corresponding stage file is incomplete.

## Stage overview

Stages are listed below in dependency order. Stage numbers preserve the original roadmap labels, so a completed later-numbered prerequisite may appear before remaining work with an earlier number. Each stage ends with something testable end to end.

| Stage | Outcome |
| --- | --- |
| [1. Contracts](stage-01-contracts.md) | Monorepo, versioned state schema, generated types, recording format |
| [2. Harness and first environment](stage-02-harness-and-first-environment.md) | Python harness, Flappy Bird, local runner, template and examples |
| [3. Backend and live sessions](stage-03-backend-and-live-sessions.md) | Backend, execution driver, sandboxed sessions, WebSocket relay |
| [4. Frontend core](stage-04-frontend-core.md) | Environment pages, live play, replay viewer, retention |
| [4.5. UI restructure](stage-04.5-ui-restructure.md) | Design tokens, primitives, navigation, accessibility |
| [5. Submissions](stage-05-submissions.md) | Git pinning, validation, overlay images, profiles, watch runs |
| [6. Seasons and leaderboards](stage-06-leaderboards.md) | Admin console, scheduler, workflow, automated and human boards |
| [7. Multi-agent](stage-07-multi-agent.md) | Hearts, multi-slot sessions, multi-submission watch flow |
| [8. Communication](stage-08-communication.md) | Spades, chat hook, routing, UI, recordings |
| [10. Documentation page](stage-10-documentation-page.md) | In-app student guides, configurable class landing |
| [11. Semantic contract](stage-11-semantic-contract.md) | Semantic observations, helper-built actions, shared spaces, template v2 |
| [13. Unified browser rendering](stage-13-unified-rendering.md) | Browser-only rendering, shared local runner, pygame-free templates |
| [12. User system](stage-12-user-system.md) | Better Auth sessions, GitHub sign-in and linking, user statuses, admin roster |
| [9. LLM API](stage-09-llm-gateway.md) | Backend proxy, retries, official and development meters, telemetry |
| [14. Environment variants](stage-14-environment-variants.md) | Typed environment parameters, season overrides, session-start tweaks, season-aware play surface |
| [15. Wide seats](stage-15-wide-seats.md) | Player and seat split, seats covering several players, per-seat results, Spades partnerships |
| [16. Pinned seats](stage-16-pinned-seats.md) | Named builtins, seats fixed to a builtin, human-or-builtin control, board exclusion |
| [17. Simultaneous stepping](stage-17-simultaneous-stepping.md) | Parallel environments, one state per tick, unified asynchronous messaging, cross-tick LLM |

Communication follows multi-agent and builds its own test bed: Spades, a partnership environment where targeted partner signals and broadcast warnings genuinely differ, while Hearts stays messaging-free. Documentation, the semantic contract, and the user system can land independently after communication. The LLM proxy and accounting model do not depend on messaging semantics, but the current Stage 9 plan comes last because it uses the semantic Hearts helpers and real account authorization, covers credentials in the existing `chat` hook, and keeps Spades as a disabled-session regression. Environment variants come next to last: they extend the season config and admin console from Stage 6, the multi-seat start flow from Stage 7, and the harness launch path as Stage 13 left it. Wide seats build directly on the reserved-parameter pattern those variants introduced, so they come after: a seat stops being the same thing as a PettingZoo player and may cover several of them, which lets one agent play a whole Spades partnership. Pinned seats and simultaneous stepping are the platform work the future role-playing environment needs and are independent of each other. Pinned seats let a scheduled seat stay with a designated builtin, controlled by a human when one takes it, while submissions rotate elsewhere. Simultaneous stepping adds parallel environments where every agent decides each tick, along with the unified asynchronous messaging model every environment adopts and the cross-tick LLM pattern. The role-playing environment itself is a later stage consuming both.

## Conventions for stage files

Each stage file contains:

- Status.
- Goal and scope.
- Related specification files.
- Dependencies.
- Implementation decisions.
- Exit criteria.

Stage files may propose defaults for choices the specification leaves open. Confirm or replace them when work starts, then edit the plan to record the current decision.
