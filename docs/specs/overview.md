# Overview

Game Sandbox is a shared playground for game-playing AI. Participants write agents, submit them through GitHub, and use a website to watch, play, rate, and compare them.

Agents may use search, rules, reinforcement learning, language models, or a mix of techniques. The platform judges the game behavior and resource use, not the implementation style.

The system is designed for classes, but it does not depend on GitHub Classroom. The same deployment can serve a workshop, club, or open competition.

## Core model

PettingZoo is the only environment interface. A compatibility wrapper lifts single-agent Gymnasium games into the same shape as native multi-agent games. See [Environments](environment.md).

Each competition round is a **season** for one environment. Participants submit a GitHub repository pinned to a commit. Sessions run agents and the environment in a sandboxed container, stream state to a browser renderer, and save that same state as a replay.

Each environment and season has two separate leaderboards:

- The **automated board** ranks game performance and shows efficiency.
- The **human-feedback board** aggregates ratings from watch and play sessions.

The scores stay separate. See [Leaderboards](leaderboard.md).

## Goals

Game Sandbox must:

- Support several environments through one interface and metadata model.
- Let people watch agents and play with or against them.
- Record every session as state that can be replayed.
- Support optional agent messaging and an OpenAI-compatible LLM API.
- Keep live sessions, agent decisions, model use, and storage bounded.
- Attribute submissions, sessions, and feedback to one GitHub identity.
- Preserve historical seasons and reproducible submissions.
- Leave room for a future Unity ML-Agents bridge without changing the frontend or leaderboard model.

## Non-goals

- Building a reinforcement learning framework.
- Running arbitrary workloads as a general-purpose code execution service.
- Replacing Gymnasium or PettingZoo.
- Supporting Unity ML-Agents in the current implementation.

## Future work

Two ideas are deliberately deferred:

- A Unity ML-Agents bridge alongside PettingZoo.
- Running pure-Python agents in the viewer's browser.

Browser execution is not used until untrusted participant code can be isolated safely. See [Execution](execution.md).
