# Overview

Game Sandbox is a classwise playground for Game AI. Participants write agents that play games, submit them through GitHub, and everyone else can watch those agents play, play against them, and rate them on a shared website. The course it is designed for covers a broad range of techniques, so an agent can be a traditional search algorithm (greedy, A*, minimax, MCTS), a rule-based system, a reinforcement learning policy, or any mix of those.

PettingZoo is the only environment framework we use. Single-agent games (Flappy Bird style, classic Atari, and similar) are wrapped into PettingZoo through an in-house, general-purpose compatibility wrapper so the rest of the system only ever sees a PettingZoo interface. See [environment.md](environment.md) for details.

Although the system is built with a class in mind, nothing in it depends on GitHub Classroom. The same deployment works for a class that uses Classroom, for a class that just collects repo links, or for a workshop, club, or open competition. See [submission.md](submission.md).

## Goals

The sandbox needs to welcome several styles of work at once:

- Traditional algorithms (greedy, A*, minimax, MCTS, rule-based).
- Reinforcement learning policies.
- Hybrids that mix search with learned components.

On top of supporting all three styles, the sandbox needs to:

- Host multiple environments behind one consistent interface, with metadata that drives the website. See [environment.md](environment.md).
- Offer agents two optional capabilities during play: a messaging channel to other agents and human-controlled slots (see [communication.md](communication.md)), and an OpenAI-compatible LLM API with built-in telemetry (see [llm.md](llm.md)).
- Provide a web frontend for watching agents, playing with or against them, and leaving feedback. See [frontend.md](frontend.md).
- Keep human-controlled live sessions bounded with a configurable timeout that is separate from agent decision timeouts. See [interaction.md](interaction.md).
- Tie every submission and every piece of feedback back to a real GitHub identity.
- Maintain two leaderboards per environment per iteration: an automated performance and efficiency board, and a separate human-feedback board. See [leaderboard.md](leaderboard.md).
- Leave a clear path open to plug in Unity ML-Agents environments later without reshaping the system.

## Non-goals

To stay focused, a few things are explicitly out of scope at this stage:

- Building a new reinforcement learning framework. Participants use whatever libraries they prefer.
- Running as a general-purpose code execution service. The sandbox runs game agents inside known environments, nothing else.
- Replacing Gym or PettingZoo. We sit on top of PettingZoo and extend it where the website needs more information.

## Future work

The long-term plan is to support Unity environments through ML-Agents alongside PettingZoo. The pieces that touch environments (the agent interface, the metadata layer, the rendering contract, the leaderboard workflow) are designed so a Unity environment can slot in without changing the frontend or the leaderboard machinery. The specific bridge between Unity ML-Agents and the rest of the system is deferred until it is needed.

A second deferred idea is running pure-Python agents directly in the viewer's browser to make casual play cheaper. It is parked until untrusted participant code can be properly isolated there; see [execution.md](execution.md).
