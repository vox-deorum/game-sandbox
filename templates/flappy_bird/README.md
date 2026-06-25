# Game Sandbox Agent Template: Flappy Bird

This repository is a complete starter project for a Flappy Bird agent. You only edit `agent.py`; everything else is provided.

An **agent** is a Python class that receives an observation and returns an action. You can play and test it on your computer before submitting the GitHub repository to Game Sandbox.

Flappy Bird is the default template. Other environments and complete worked agents are published as `templates/<env>` and `examples/<env>/<name>` branches of the same student repository.

## Project files

| Path | Purpose |
| --- | --- |
| `agent.py` | Your agent implementation — the only file you edit |
| `manifest.json` | Tells Game Sandbox where the agent class lives |
| `requirements.txt` | Exact Python package versions used by the server |
| `requirements-dev.txt` | Test dependencies |
| `tests/` | Checks your submission should pass |
| `sandbox/` | Provided tooling: the local game, the play/evaluate scripts, and the `python -m sandbox` helper — do not edit |
| `.env.example` | Example local LLM settings |

Do not edit anything in `sandbox/`, `requirements.in`, or `requirements.txt`. The template pins one shared dependency set so local runs and server runs use the same packages. If the class needs another package, ask your instructor for a new template release.

## Set up and play — one command

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

For Flappy Bird, the observation is a NumPy array with 12 normalized values describing the bird and nearby pipes. Return `0` to do nothing or `1` to flap.

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

## Optional LLM API

If your instructor enables model calls:

1. Copy `.env.example` to `.env`.
2. Add the endpoint and key provided by your instructor.
3. Run `python -m sandbox.llm_example`.

Never commit `.env` or an API key to GitHub.

Your code reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` both locally and on the server. During a server session, Game Sandbox supplies a temporary key scoped to that session and agent slot, so the agent code does not change.

## Dependency updates

The shared dependency set is controlled by the template release. Do not install or pin extra packages in a submission. Ask your instructor if the class needs a new package.
