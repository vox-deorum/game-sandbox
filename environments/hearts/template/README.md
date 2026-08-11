# Game Sandbox Agent Template: Hearts

This repository is a complete starter project for a Hearts agent. Edit `agent.py` and, if you use the optional LLM API, a local `.env` file. Everything in `sandbox/` is provided.

An **agent** is a Python class that receives an observation and returns an action. You can play and test it on your computer before submitting the GitHub repository to Game Sandbox.

Hearts is a four-player trick-taking game. See the course documentation for the environments and examples available to your class.

## Project files

| Path | Purpose |
| --- | --- |
| `agent.py` | Your agent implementation |
| `environment.md` | The Hearts reference: rules, observations, helpers, scoring, and limits |
| `manifest.json` | Tells Game Sandbox where the agent class lives |
| `season.json` | Optional local season settings downloaded from My Submissions |
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

The first run creates `.venv`, installs the pinned packages, and opens a game you control by clicking a highlighted card. **Naive** is a simple built-in agent you can use as a consistent opponent while you improve your own agent.

Use these commands as you work:

```console
python -m sandbox            # play one chosen position yourself; your agent runs the other three
python -m sandbox watch      # watch your agent play three copies of Naive
python -m sandbox watch --headless  # run that same game without a browser
python -m sandbox eval       # compare your agent with Naive over repeatable games
python -m sandbox watch --decision-limit-ms 500  # override the decision limit for this run
python -m sandbox test       # run the checks
python -m sandbox setup      # just (re)install dependencies into .venv
```

When `season.json` is present beside `manifest.json`, `play`, `watch`, and `eval` use its settings automatically.

Useful options:

- `--seed N`, for example `python -m sandbox watch --seed 7`, repeats the same game.
- `python -m sandbox play --seat 2` lets you play player 2. In Hearts, each seat contains one player.
- `--vs rivals/v1` uses a saved rival in the other positions. `watch` and `eval` keep your current agent in the selected position; `play` keeps the position you control. The getting started guide explains how to make the rival folder.
- `eval` reports the higher-is-better leaderboard score, so a Hearts result closer to zero is better. Use it to compare changes against the same seeds, not to predict leaderboard results.

The [getting started guide]({{DOCS_URL}}students/getting-started/) explains manual virtual-environment setup and the GitHub workflow.

## Write the agent

Open `agent.py` and implement:

- `reset(seed, observation)`, called once before each game with the first-turn observation.
- `act(observation)`, called on your turn to return the card you want to play.

Read [`environment.md`](environment.md) before you start: it explains the starter agent, rules, observations, `sandbox.cards` helpers, scoring, and time limits.

Two optional methods are available; see the [agent interface reference]({{DOCS_URL}}students/agent-interface/) for their full signatures:

- `learn(observation, action, reward, terminated)` updates a learning agent after a step.
- `chat(inbox)` sends messages in environments that enable communication. Hearts ships with messaging off.

Leave out any optional method you do not use.

The template already plays its lowest-ranked legal card. `TODO(you)` in `act` marks where to improve it.

## Submit

Submit the repository URL through the course website. Game Sandbox pins one commit, and a later submission replaces it while the season is open. The [submitting guide]({{DOCS_URL}}students/submitting/) covers validation and common errors.

## Optional LLM API

If your instructor enables model calls, follow [Using the LLM API](llm.md). Copy `.env.example` to `.env`, add the endpoint and key, and never commit either secret.

Test the connection with:

```console
python -m sandbox llm
```
