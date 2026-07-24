# Game Sandbox Specification

These pages define Game Sandbox product behavior and system boundaries. Contributor guides explain how the current code works, while the [implementation plan](https://github.com/vox-deorum/game-sandbox/blob/main/plans/README.md) tracks build order and status.

Start with the [overview](overview.md). For a complete introduction, continue with [Environments](environment.md), [Interaction](interaction.md), and [Submissions](submission.md). These pages introduce the concepts used throughout the rest of the specification. Then use this table to find details as needed:

| Topic | Defines |
| --- | --- |
| [Environments](environment.md) | PettingZoo interface, seeding, public metadata |
| [Interaction](interaction.md) | Browser rendering, session stepping, human input |
| [Submissions](submission.md) | Agent hooks, packaging, templates, validation |
| [Communication](communication.md) | Optional agent and human messaging |
| [LLM API](llm.md) | Backend proxy access, keys, budgets, retries, telemetry |
| [Frontend](frontend.md) | Navigation, pages, play/watch flows, ratings, identity |
| [Leaderboards](leaderboard.md) | Seasons, automated ranking, human feedback |
| [Execution](execution.md) | Runtime boundary, containers, drivers, sandboxing |
| [Recording](recording.md) | State-only recordings, replay, retention |

```text
Student repository → Submission → Session container → State stream → Browser renderer
                                      │
                                      └──────────────→ Recording → Replay
```
