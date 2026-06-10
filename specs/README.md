# Game Sandbox Specification

The specification is split across several files so each topic can be read on its own. Start with the overview, then jump to whatever section you need.

- [overview.md](overview.md). What the project is, who it's for, goals and non-goals, future work.
- [environment.md](environment.md). The environment framework (PettingZoo with Shimmy for single-agent games) and the metadata layers.
- [interaction.md](interaction.md). How a game is rendered in the browser and how human input flows back to the game.
- [submission.md](submission.md). The agent interface, the template repos, and how participants submit.
- [communication.md](communication.md). Optional messaging between agents and the human player: the chat hook, message limits, visibility, and recording.
- [llm.md](llm.md). The OpenAI-compatible LLM API for agents: the gateway, one-off session keys, telemetry, budgets, and what it means for sandboxing and the leaderboard.
- [frontend.md](frontend.md). Pages, the submission form, play and watch flows, on-demand live play, feedback, and GitHub OAuth identity.
- [leaderboard.md](leaderboard.md). What an iteration is, the automated board, and the human-feedback board.
- [execution.md](execution.md). Where the renderer, the environment, and the agents run, how the session container is sandboxed, and the implementation languages.
- [recording.md](recording.md). State-only recordings, replays, and storage.
