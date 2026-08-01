# Game Sandbox Specification

These pages define Game Sandbox product behavior and system boundaries. Contributor guides explain how the current code works, while the [implementation plan](https://github.com/vox-deorum/game-sandbox/blob/main/plans/README.md) tracks build order and status.

Start with the [overview](overview.md). For a complete introduction, continue with [Environments](environment.md), [Interaction](interaction.md), [Seasons](seasons.md), and [Submissions](submission.md). Together they cover the concepts the rest of the specification builds on. Then use this table to find details as needed:

| Topic | Defines |
| --- | --- |
| [Environments](environment.md) | PettingZoo interface, seeding, public metadata |
| [Interaction](interaction.md) | Browser rendering, session stepping, human input, chat panel UI |
| [Seasons](seasons.md) | Competition rounds, public gates, per-season configuration |
| [Submissions](submission.md) | Agent hooks, packaging, templates, validation |
| [Communication](communication.md) | Optional agent and human messaging |
| [LLM API](llm.md) | Backend proxy access, keys, budgets, retries, telemetry |
| [Frontend](frontend.md) | Navigation, pages, play/watch flows, ratings |
| [Identity](identity.md) | Accounts, sign-in, statuses, bans |
| [Leaderboards](leaderboard.md) | Automated ranking, human feedback |
| [Execution](execution.md) | Runtime boundary, containers, drivers, sandboxing |
| [Deployment](deployment.md) | Where the app process runs, daemon topology, containerized mode |
| [Recording](recording.md) | State-only recordings, replay, retention |

```text
Live path:
Student repository → Submission → Session container → State stream → Browser renderer
                                      │
                                      └──────────────→ Recording → Replay

Automated run: Submissions → Session containers (headless) → Recordings
```
