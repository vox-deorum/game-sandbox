# Game Sandbox Agent Template: Flappy Bird

This repository is a complete starter project for a Flappy Bird agent. Edit `agent.py` and, if you use the optional LLM API, a local `.env` file. Everything in `sandbox/` is provided.

An **agent** is a Python class that receives an observation and returns an action. You can play and test it on your computer before submitting the GitHub repository to Game Sandbox.

Flappy Bird is the default template. See the course documentation for the environments and examples available to your class.

## Project files

| Path | Purpose |
| --- | --- |
| `agent.py` | Your agent implementation |
| `environment.md` | The Flappy Bird reference: the starter agent, observations, actions, helpers, scoring, and limits |
| `manifest.json` | Tells Game Sandbox where the agent class lives |
| `requirements.txt` | Exact Python package versions used by the server |
| `requirements-dev.txt` | Test dependencies |
| `tests/` | Checks your submission should pass |
| `sandbox/` | Provided local game and commands. Do not edit it. |
| `sandbox/features.py` | Provided feature helpers you may import from `agent.py` (named observation indices and actions) |
| `.env.example` | Example local LLM settings |

Do not edit `sandbox/`, `requirements.in`, or `requirements.txt`. The template uses the same pinned packages locally and on the server. Ask your instructor if you need another package.

## Set up and play in one command

From the project folder:

```console
python -m sandbox
```

The first run creates `.venv`, installs the pinned packages, and opens a game you control with **space** or the **up arrow**. Use these commands as you work:

```console
python -m sandbox            # play it yourself
python -m sandbox play       # run YOUR agent in a window (add --headless for no window)
python -m sandbox eval       # run several seeded episodes and report the mean score
python -m sandbox test       # run the checks
python -m sandbox setup      # just (re)install dependencies into .venv
```

The [getting started guide]({{DOCS_URL}}students/getting-started/) explains manual virtual-environment setup and GitHub workflow.

## Write the agent

Open `agent.py` and implement:

- `reset(seed)`, called once before each game.
- `act(observation)`, called whenever the agent must choose.

Read [`environment.md`](environment.md) before you start. It explains the starter agent, observation, actions, `sandbox.features` helpers, scoring, and time limits.

Two optional methods are available:

- `learn(observation, action, reward, terminated)` updates a learning agent after a step.
- `chat(inbox)` sends messages in environments that enable communication.

Leave an optional method out when you do not use it.

The template already plays. Its agent flaps below the middle of the screen, and `TODO(you)` in `act` marks where to improve it.

## Submit

Submit the repository URL through the course website. Game Sandbox pins one commit, and a later submission replaces it while the season is open. The [submitting guide]({{DOCS_URL}}students/submitting/) covers validation and common errors.

## Optional LLM API

If your instructor enables model calls, follow [Using the LLM API](llm.md). Copy `.env.example` to `.env`, add the endpoint and key, and never commit either secret.
