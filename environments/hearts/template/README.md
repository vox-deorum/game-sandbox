# Game Sandbox Agent Template: Hearts

This repository is a complete starter project for a Hearts agent. Edit `agent.py` and, if you use the optional LLM API, a local `.env` file. Everything in `sandbox/` is provided.

An **agent** is a Python class that receives an observation and returns an action. You can play and test it on your computer before submitting the GitHub repository to Game Sandbox.

Hearts is a four-player trick-taking game. Your agent fills one player position while built-in opponents play the other three. See the course documentation for the environments and examples available to your class.

## Project files

| Path | Purpose |
| --- | --- |
| `agent.py` | Your agent implementation |
| `environment.md` | The Hearts reference: rules, observations, helpers, scoring, and limits |
| `manifest.json` | Tells Game Sandbox where the agent class lives |
| `requirements.txt` | Exact Python package versions used by the server |
| `requirements-dev.txt` | Test dependencies |
| `tests/` | Checks your submission should pass |
| `sandbox/` | Provided local game and commands. Do not edit it. |
| `sandbox/cards.py` | Provided card helpers you may import from `agent.py` (decode cards, read the observation) |
| `.env.example` | Example local LLM settings |

Do not edit `sandbox/`, `requirements.in`, or `requirements.txt`. The template uses the same pinned packages locally and on the server. Ask your instructor if you need another package.

## Set up and play in one command

From the project folder:

```console
python -m sandbox
```

The first run creates `.venv`, installs the pinned packages, and opens a game you control by clicking a highlighted card. Use these commands as you work:

```console
python -m sandbox            # play it yourself
python -m sandbox play       # watch YOUR agent play a player (add --headless for no window)
python -m sandbox eval       # run several seeded games and report the mean score
python -m sandbox test       # run the checks
python -m sandbox setup      # just (re)install dependencies into .venv
```

Use `python -m sandbox play --seed 7` for a repeatable game or `python -m sandbox human --player 2` to play a different position. The [getting started guide]({{DOCS_URL}}students/getting-started/) explains manual virtual-environment setup and GitHub workflow.

## Write the agent

Open `agent.py` and implement:

- `reset(seed)`, called once before each game.
- `act(observation)`, called on your turn to return the card you want to play.

Read [`environment.md`](environment.md) before you start. It explains the starter agent, rules, observations, `sandbox.cards` helpers, scoring, and time limits.

Two optional methods are available:

- `learn(observation, action, reward, terminated)` updates a learning agent after a step.
- `chat(inbox)` sends messages in environments that enable communication. Hearts ships with messaging off.

Leave an optional method out when you do not use it.

The template already plays its lowest-ranked legal card. `TODO(you)` in `act` marks where to improve it.

## Submit

Submit the repository URL through the course website. Game Sandbox pins one commit, and a later submission replaces it while the season is open. The [submitting guide]({{DOCS_URL}}students/submitting/) covers validation and common errors.

## Optional LLM API

If your instructor enables model calls, follow [Using the LLM API](llm.md). Copy `.env.example` to `.env`, add the endpoint and key, and never commit either secret.
