# Game Sandbox Agent Template: Flappy Bird

This repository is a complete starter project for a Flappy Bird agent. You only edit `agent.py`; everything else is provided.

An **agent** is a Python class that receives an observation and returns an action. You can play and test it on your computer before submitting the GitHub repository to Game Sandbox.

Flappy Bird is the default template. Other environments and complete worked agents are published as `templates/<env>` and `examples/<env>/<name>` branches of the same student repository.

## Project files

| Path | Purpose |
| --- | --- |
| `agent.py` | Your agent implementation, the only file you edit |
| `environment.md` | Full reference for this game: the observation, the actions, the `sandbox.features` helpers, a worked minimal agent, scoring, and time limits |
| `manifest.json` | Tells Game Sandbox where the agent class lives |
| `requirements.txt` | Exact Python package versions used by the server |
| `requirements-dev.txt` | Test dependencies |
| `tests/` | Checks your submission should pass |
| `sandbox/` | Provided tooling: the local game, the play/evaluate scripts, and the `python -m sandbox` helper; do not edit |
| `sandbox/features.py` | Provided feature helpers you may import from `agent.py` (named observation indices and actions) |
| `.env.example` | Example local LLM settings |

Do not edit anything in `sandbox/`, `requirements.in`, or `requirements.txt`. The template pins one shared dependency set so local runs and server runs use the same packages. If the class needs another package, ask your instructor for a new template release.

## Set up and play in one command

From the project folder:

```console
python -m sandbox
```

The first time you run it, it creates a local `.venv`, installs the pinned packages, and then opens the game for you to play yourself (press **space** or the **up arrow** to flap). There is no separate install step. As you work, the same command gives you everything:

```console
python -m sandbox            # play it yourself
python -m sandbox play       # run YOUR agent in a window (add --headless for no window)
python -m sandbox eval       # run several seeded episodes and report the mean score
python -m sandbox test       # run the checks
python -m sandbox setup      # just (re)install dependencies into .venv
```

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
- `act(observation)`, called whenever the agent must choose.

Everything specific to Flappy Bird is in [`environment.md`](environment.md), the reference shipped alongside this README: what the 12-value observation contains, the two action integers, the `sandbox.features` helpers that name them, a worked minimal agent, the scoring, and the time limits. Read it before you start; it is all you need to build the agent.

Two optional methods are available:

- `learn(observation, action, reward, terminated)` updates a learning agent after a step.
- `chat(inbox)` sends messages in environments that enable communication.

Leave an optional method out when you do not use it.

The unfinished template fails `python -m sandbox test` because `act` raises `NotImplementedError`. That failure is your signal to implement the method.

## Save work to GitHub

Git stores project history as **commits**. A typical save cycle is:

```console
git status
git add agent.py
git commit -m "Implement Flappy Bird agent"
git push
```

Review `git status` before adding files, and never add `.env` or an API key. See GitHub's [About Git guide](https://docs.github.com/en/get-started/using-git/about-git) if these commands are new.

## Submit

Submit the repository URL through the course website. Game Sandbox pins one exact commit, validates the repository, and prepares a runnable image.

Submitting again while the season is open replaces the active submission and keeps the earlier submission in history.

## Dependency updates

The shared dependency set is controlled by the template release. Do not install or pin extra packages in a submission. Ask your instructor if the class needs a new package.
