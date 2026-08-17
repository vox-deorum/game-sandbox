# Game Sandbox Agent Template: Flappy Bird

This repository is a complete starter project for a Flappy Bird agent. Edit `agent.py` and add a local `.env` file if you use the optional LLM API. Everything in `sandbox/` is provided.

An **agent** is a Python class that receives an observation and returns an action. You can play and test it on your computer before submitting the GitHub repository to Game Sandbox.

Flappy Bird is the default template. See the course documentation for the environments and examples available to your class.

## Project files

| Path | Purpose |
| --- | --- |
| `agent.py` | Your agent implementation |
| `environment.md` | The Flappy Bird reference: the starter agent, observations, actions, helpers, scoring, and limits |
| `manifest.json` | Tells Game Sandbox where the agent class lives |
| `season.json` | Optional local season settings downloaded from My Submissions |
| `requirements.txt` | Exact Python package versions used by the server |
| `requirements-dev.txt` | Test dependencies |
| `tests/` | Checks your submission should pass |
| `sandbox/` | Provided local game and commands. Do not edit it. |
| `sandbox/features.py` | Provided feature helpers you may import from `agent.py` (named observation values and actions) |
| `.env.example` | Example local LLM settings |

Do not edit `sandbox/`, `requirements.in`, or `requirements.txt`. The template uses the same pinned packages locally and on the server. Ask your instructor if you need another package.

## Set up and play in one command

From the project folder:

```console
python -m sandbox
```

The first run creates `.venv`, installs the pinned packages, and opens a game you control with **space**, the **up arrow**, or **W**. Use these commands as you work:

```console
python -m sandbox            # play it yourself
python -m sandbox watch      # run YOUR agent in your browser (add --headless to run without opening the browser)
python -m sandbox eval       # run several seeded episodes and report the mean score
python -m sandbox watch --parameter pipe_gap=120  # override one setting for this run
python -m sandbox test       # run the checks
python -m sandbox setup      # just (re)install dependencies into .venv
```

When `season.json` is present beside `manifest.json`, `play`, `watch`, and `eval` use its settings automatically.

The [getting started guide]({{DOCS_URL}}students/getting-started/) explains manual virtual-environment setup and the GitHub workflow.

## Write the agent

Open `agent.py` and implement the required `reset(seed, observation)` and `act(observation)` methods. Read [`environment.md`](environment.md) before you start; it explains the starter agent, the observation, the actions, the `sandbox.features` helpers, scoring, and time limits. The optional `learn` and `chat` methods are described in the [agent interface reference]({{DOCS_URL}}students/agent-interface/). Leave an optional method out when you do not use it.

The template already plays. Its agent flaps whenever the bird is below the middle of the screen, and `TODO(you)` in `act` marks where to improve it.

## Submit

Submit the repository URL through the course website. The [submitting guide]({{DOCS_URL}}students/submitting/) covers validation and common errors.

## Optional LLM API

If your instructor enables model calls, follow [Using the LLM API](llm.md). Copy `.env.example` to `.env`, add the endpoint and key, and never commit either secret.

Test the connection with:

```console
python -m sandbox llm
```
