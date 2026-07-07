# Implementation Plan

The [specification](../docs/specs/README.md) defines the system. This folder tracks how it is built, in dependency order.

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

Stages are ordered by dependency. Each stage ends with something testable end to end.

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
| [9. LLM gateway](stage-09-llm-gateway.md) | Slot keys, telemetry, budgets, owner debug data |
| [10. Documentation page](stage-10-documentation-page.md) | In-app student guides, configurable class landing |
| [11. Semantic contract](stage-11-semantic-contract.md) | Object-shaped observations, simple actions + helpers, shared spaces, template v2 |

Communication follows multi-agent and builds its own test bed: Spades, a partnership environment where targeted partner signals and broadcast warnings genuinely differ, while Hearts stays messaging-free. The LLM gateway is independent and comes last.

## Conventions for stage files

Each stage file contains:

- Status.
- Goal and scope.
- Related specification files.
- Dependencies.
- Implementation decisions.
- Exit criteria.

Stage files may propose defaults for choices the specification leaves open. Confirm or replace them when work starts, then edit the plan to record the current decision.
