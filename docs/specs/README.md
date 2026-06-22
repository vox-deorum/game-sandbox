# Game Sandbox Specification

The specification is the authority for product behavior and system boundaries. Contributor guides explain how the current code implements it. The [implementation plan](https://github.com/vox-deorum/game-sandbox/blob/main/plans/README.md) explains build order and status.

Start with the [overview](overview.md), then use this map:

| Topic | Defines |
| --- | --- |
| [Environments](environment.md) | PettingZoo interface, seeding, public metadata |
| [Interaction](interaction.md) | Browser rendering, session stepping, human input |
| [Submissions](submission.md) | Agent hooks, packaging, templates, validation |
| [Communication](communication.md) | Optional agent and human messaging |
| [LLM API](llm.md) | Gateway access, keys, budgets, telemetry |
| [Frontend](frontend.md) | Navigation, pages, play/watch flows, ratings, identity |
| [Leaderboards](leaderboard.md) | Seasons, automated ranking, human feedback |
| [Execution](execution.md) | Runtime boundary, containers, drivers, sandboxing |
| [Recording](recording.md) | State-only recordings, replay, retention |

```text
Student repository → Submission → Session container → State stream → Browser renderer
                                      │
                                      └──────────────→ Recording → Replay
```
