# Game Sandbox Agent Template: Hearts

This repository is a complete starter project for a Hearts agent. You only edit `agent.py`; everything else is provided.

An **agent** is a Python class that receives an observation and returns an action. You can play and test it on your computer before submitting the GitHub repository to Game Sandbox.

Hearts is a four-player trick-taking game. Your agent fills one seat; the other three seats are played by a built-in opponent while you develop locally. Other environments and complete worked agents are published as `templates/<env>` and `examples/<env>/<name>` branches of the same student repository.

## Project files

| Path | Purpose |
| --- | --- |
| `agent.py` | Your agent implementation, the only file you edit |
| `environment.md` | Full reference for this game: a walkthrough of the starting agent you already have, then the rules, the card encoding, every observation field, the `sandbox.cards` helpers, scoring, and time limits |
| `manifest.json` | Tells Game Sandbox where the agent class lives |
| `requirements.txt` | Exact Python package versions used by the server |
| `requirements-dev.txt` | Test dependencies |
| `tests/` | Checks your submission should pass |
| `sandbox/` | Provided tooling: the local game, the play/evaluate scripts, and the `python -m sandbox` helper; do not edit |
| `sandbox/cards.py` | Provided card helpers you may import from `agent.py` (decode cards, read the observation) |
| `.env.example` | Example local LLM settings |

Do not edit anything in `sandbox/`, `requirements.in`, or `requirements.txt`. The template pins one shared dependency set so local runs and server runs use the same packages. If the class needs another package, ask your instructor for a new template release.

## Set up and play in one command

From the project folder:

```console
python -m sandbox
```

The first time you run it, it creates a local `.venv`, installs the pinned packages, and then opens a window where you take a seat and play Hearts yourself; click a highlighted (legal) card on your turn. There is no separate install step. As you work, the same command gives you everything:

```console
python -m sandbox            # take a seat and play it yourself
python -m sandbox play       # watch YOUR agent play a seat (add --headless for no window)
python -m sandbox eval       # run several seeded games and report the mean score
python -m sandbox test       # run the checks
python -m sandbox setup      # just (re)install dependencies into .venv
```

Useful extra flags pass straight through, e.g. `python -m sandbox play --seed 7` or `python -m sandbox human --seat 2` to sit in a different seat.

Prefer to manage the virtual environment yourself? Create and activate one, install the requirements, then use the same commands.

On Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt -r requirements-dev.txt
```

On macOS or Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt -r requirements-dev.txt
```

See Python's [virtual environment guide](https://docs.python.org/3/tutorial/venv.html) if this is your first time using one.

## Write the agent

Open `agent.py` and implement:

- `reset(seed)`, called once before each game.
- `act(observation)`, called on your turn to return the card you want to play.

Everything specific to Hearts is in [`environment.md`](environment.md), the reference shipped alongside this README: it walks through the starting agent you already have, then covers the rules, the card encoding, every observation field, the `sandbox.cards` helpers that decode them, the scoring, and the time limits. Read it before you start; it is all you need to build the agent.

Two optional methods are available:

- `learn(observation, action, reward, terminated)` updates a learning agent after a step.
- `chat(inbox)` sends messages in environments that enable communication. Hearts ships with messaging off.

Leave an optional method out when you do not use it.

The template already plays. `agent.py` ships a small working agent that plays its lowest-ranked legal card, so `python -m sandbox test` passes and `python -m sandbox play` works before you change anything. The `TODO(you)` comment inside `act` marks where to start improving it. Run `python -m sandbox play` to watch your agent take a seat against the built-in opponents, and `python -m sandbox` to play a seat yourself.

## Save work to GitHub

Git stores project history as **commits**. A typical save cycle is:

```console
git status
git add agent.py
git commit -m "Implement Hearts agent"
git push
```

Review `git status` before adding files, and never add `.env` or an API key. See GitHub's [About Git guide](https://docs.github.com/en/get-started/using-git/about-git) if these commands are new.

## Submit

Submit the repository URL through the course website. Game Sandbox pins one exact commit, validates the repository, and prepares a runnable image.

Submitting again while the season is open replaces the active submission and keeps the earlier submission in history.

## Optional LLM API

If your instructor enables model calls:

1. Follow [Using the LLM API](llm.md) to request a season development key.
2. Copy `.env.example` to `.env`, add the returned endpoint and key, and select an allowed model alias.
3. Run `python -m sandbox llm` to make one smoke-test call.

Never commit `.env` or an API key to GitHub.

Your code reads `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` locally. When official LLM access is enabled for the environment and season, Game Sandbox supplies a temporary endpoint and key scoped to that session and agent slot, so the agent code does not change.

## Dependency updates

The shared dependency set is controlled by the template release. Do not install or pin extra packages in a submission. Ask your instructor if the class needs a new package.
