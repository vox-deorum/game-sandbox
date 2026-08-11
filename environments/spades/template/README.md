# Game Sandbox Agent Template: Spades

This repository is a complete starter project for a Spades agent. Edit `agent.py` and, if you use the optional LLM API, a local `.env` file. Everything in `sandbox/` is provided.

An **agent** is a Python class that receives an observation and returns an action. You can play and test it on your computer before submitting the GitHub repository to Game Sandbox.

Spades is a four-player partnership card game. The player across the table is your partner. See the course documentation for the environments and examples available to your class.

## Project files

| Path | Purpose |
| --- | --- |
| `agent.py` | Your agent implementation |
| `environment.md` | The Spades reference: rules, observations, helpers, scoring, and limits |
| `manifest.json` | Tells Game Sandbox where the agent class lives |
| `season.json` | Optional local season settings downloaded from My Submissions |
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

The first run creates `.venv`, installs the pinned packages, and opens a game you control. Click a bid chip during bidding and a highlighted card during play. **Naive** is a simple built-in agent you can use as a consistent opponent or partner while you improve your own agent.

Use these commands as you work:

```console
python -m sandbox            # control your partnership yourself; your agent runs the opponents
python -m sandbox watch      # watch your partnership play the Naive partnership
python -m sandbox watch --headless  # run that same game without a browser
python -m sandbox eval       # compare your partnership with Naive over repeatable games
python -m sandbox watch --parameter seat_plan=solo  # override one setting for this run
python -m sandbox test       # run the checks
python -m sandbox setup      # just (re)install dependencies into .venv
```

When `season.json` is present beside `manifest.json`, `play`, `watch`, and `eval` use its settings automatically.

These options use the default `partnership` setting:

- `watch --seed 7` repeats the same game.
- `python -m sandbox play --seat 1` lets you play the other partnership.
- Playing by hand lets you control both partners by default. Add `--companion naive` or an agent folder to control one player while that agent controls your partner. The opposing partnership runs your own agent, so you can play against what you built.
- `--vs rivals/v1` uses a saved rival for the other partnership. `watch` keeps your current agent on your partnership; `play` keeps your controls and companion. The option also works with `eval`. The getting started guide explains how to make the rival folder.
- `eval` reports a higher-is-better team score. It is useful for comparing changes against the same seeds, not for predicting leaderboard results.

The [getting started guide]({{DOCS_URL}}students/getting-started/) explains manual virtual-environment setup and the GitHub workflow.

## Write the agent

Open `agent.py` and implement:

- `reset(seed, observation)`, called once before each game with the first-turn observation.
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
