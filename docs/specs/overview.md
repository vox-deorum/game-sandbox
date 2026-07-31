# Overview

Game Sandbox is a shared playground for game-playing AI. Participants write agents, submit them through GitHub, and use a website to watch, play, rate, and compare them.

Agents may use search, rules, reinforcement learning, language models, or any combination of techniques. The platform evaluates their game behavior and resource use, not how they are implemented.

The system is designed for classes, but it does not depend on GitHub Classroom. The same deployment can serve a workshop, club, or open competition.

## Core model

PettingZoo is the only environment interface. A compatibility wrapper makes single-agent Gymnasium games look like native multi-agent games to the rest of the system. See [Environments](environment.md).

An agent is bound to a **seat**, which covers one or more of the environment's players and is scored as one unit. Most games give every seat a single player. A partnership or squad game gives a seat several players, and that seat's score is the mean of their scores.

Each competition round is a **season** for one environment. See [Seasons](seasons.md). An **operator** is a signed-in user with `admin` status who manages seasons and runs. Participants submit a GitHub repository pinned to a specific commit. A session runs the environment and any agent-controlled players in a sandboxed container. The **harness** is the process inside the session container that steps the environment, drives every agent-controlled player, and emits the per-step state. The session streams that state to a browser renderer and saves the canonical state for replay.

Each season of an environment has two leaderboards:

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
- Attribute submissions, sessions, and feedback to one authenticated account identity.
- Preserve historical seasons and reproducible submissions.

## Non-goals

- Building a reinforcement learning framework.
- Running arbitrary workloads as a general-purpose code execution service.
- Replacing Gymnasium or PettingZoo.
- Supporting Unity ML-Agents or browser execution of untrusted participant code in the current implementation.

## Future work

Future extensions may add a Unity ML-Agents bridge and browser execution of pure-Python agents once untrusted participant code can be isolated safely. See [Execution](execution.md).
