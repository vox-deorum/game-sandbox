# Game Sandbox Agent Template: Spades

This repository is a complete starter project for a Spades agent. Edit `agent.py` and, if you use the optional LLM API, a local `.env` file. Everything in `sandbox/` is provided.

An **agent** is a Python class that receives an observation and returns an action. You can play and test it on your computer before submitting the GitHub repository to Game Sandbox.

Spades is a four-player partnership card game. The player across the table is your partner. Unless you pick a saved rival with `--vs`, local play runs a separate copy of this repository's agent for every agent-controlled player. See the course documentation for the environments and examples available to your class.

## Project files

| Path | Purpose |
| --- | --- |
| `agent.py` | Your agent implementation |
| `environment.md` | The Spades reference: rules, observations, helpers, scoring, and limits |
| `manifest.json` | Tells Game Sandbox where the agent class lives |
| `requirements.txt` | Exact Python package versions used by the server |
| `requirements-dev.txt` | Test dependencies |
| `tests/` | Checks your submission should pass |
| `sandbox/` | Provided local game and commands. Do not edit it. |
| `sandbox/cards.py` | Provided card helpers you may import from `agent.py` (decode cards and bids, read the observation) |
| `.env.example` | Example local LLM settings |

Do not edit `sandbox/`, `requirements.in`, or `requirements.txt`. The template uses the same pinned packages locally and on the server. Ask your instructor if you need another package.

## Set up and play in one command

From the project folder:

```console
python -m sandbox
```

The first run creates `.venv`, installs the pinned packages, and opens a game you control. Click a bid chip during bidding and a highlighted card during play. Use these commands as you work:

```console
python -m sandbox            # play one chosen position yourself; your agent runs the other three
python -m sandbox play       # watch separate copies of your agent play all four positions
python -m sandbox play --headless  # run one selected agent position with legal default actions elsewhere
python -m sandbox eval       # repeat that headless check over seeded episodes and report the mean score
python -m sandbox test       # run the checks
python -m sandbox setup      # just (re)install dependencies into .venv
```

A few notes on these commands:

- `play --seed 7` repeats the same game.
- `human --player 2` lets you play a different position.
- `play --vs rivals/v1` plays your partnership against a saved rival, a folder holding that version's `agent.py` and `manifest.json`. Your partner keeps your current agent, and the flag also works with `human` and `eval`.
- `eval` reports a higher-is-better team score. It is useful for comparing changes against the same seeds, not for predicting leaderboard results.

The [getting started guide]({{DOCS_URL}}students/getting-started/) explains manual virtual-environment setup and the GitHub workflow.

## Write the agent

Open `agent.py` and implement:

- `reset(seed)`, called once before each game.
- `act(observation)`, called on your turn. Choose a bid with `bid(k)` during bidding or a card with `play(card)` during card play. Each helper returns the integer `act` must return.

Read [`environment.md`](environment.md) before you start. It explains the starter agent, rules, observations, `sandbox.cards` helpers, scoring, and time limits.

Two optional methods are available. The [agent interface reference]({{DOCS_URL}}students/agent-interface/) covers both in full:

- `learn(observation, action, reward, terminated)` updates a learning agent after a step.
- `chat(inbox)` sends and receives messages. Spades enables messaging, and `agent.py` includes a commented-out `chat` hook to start from.

Leave an optional method out when you do not use it.

The template bids one trick and plays its lowest-ranked legal card. `TODO(you)` in `act` marks where to improve it.

## Submit

Submit the repository URL through the course website. Game Sandbox pins one commit, and a later submission replaces it while the season is open. The [submitting guide]({{DOCS_URL}}students/submitting/) covers validation and common errors.

## Optional LLM API

If your instructor enables model calls, follow [Using the LLM API](llm.md). Copy `.env.example` to `.env`, add the endpoint and key, and never commit either secret.

Test the connection with:

```console
python -m sandbox llm
```
