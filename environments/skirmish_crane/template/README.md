# Game Sandbox Agent Template: Skirmish at Crane Reach

This repository is a complete starter project for a Skirmish at Crane Reach agent. Edit `agent.py`. Everything in `sandbox/` is provided.

An **agent** is a Python class that receives an observation and returns an action. You can play and test it on your computer before submitting the GitHub repository to Game Sandbox.

Skirmish at Crane Reach is a team tactics game on a hex field: two sides fight over the ground, and every unit on a side runs its own separately constructed copy of the same `Agent` class, with no memory shared between them. Unless you pick a saved rival with `--vs`, local play runs a separate copy of this repository's agent for every unit. See the course documentation for the environments and examples available to your class.

## Project files

| Path | Purpose |
| --- | --- |
| `agent.py` | Your agent implementation |
| `environment.md` | The Skirmish at Crane Reach reference: rules, observations, the action mask, and local play |
| `manifest.json` | Tells Game Sandbox where the agent class lives |
| `season.json` | Optional local season settings downloaded from My Submissions |
| `requirements.txt` | Exact Python package versions used by the server |
| `requirements-dev.txt` | Test dependencies |
| `tests/` | Checks your submission should pass |
| `sandbox/` | Provided local game and commands. Do not edit it. |
| `sandbox/crane.py` | Provided helpers you may import from `agent.py`: encode and decode paths, measure hex distance, and build legal move and stay orders |
| `sandbox/observation_types.py` | Provided TypedDicts for the observation and action shapes, for editors and type checkers |

Do not edit `sandbox/`, `requirements.in`, or `requirements.txt`. The template uses the same pinned packages locally and on the server. Ask your instructor if you need another package.

## Set up and play in one command

From the project folder:

```console
python -m sandbox
```

The first run creates `.venv`, installs the pinned packages, and opens a game where you control one unit: click a highlighted tile to extend its path, click the unit to clear the path, and confirm to send the order. Use these commands as you work:

```console
python -m sandbox play       # watch separate copies of your agent play both sides in the browser
python -m sandbox human      # play a unit yourself in the browser; --player N picks it, --companion self takes your whole team
python -m sandbox eval       # run seeded episodes headlessly and report the mean score
python -m sandbox eval --vs rivals/v1  # evaluate against a saved copy of an agent
python -m sandbox test       # run the checks
python -m sandbox setup      # just (re)install dependencies into .venv
```

When `season.json` is present beside `manifest.json`, `human`, `play`, and `eval` use its settings automatically.

A few notes on these commands:

- `play --seed 7` repeats the same game.
- `human --player 2` lets you play a different unit; `--companion self` lets you play every unit on your team instead of just one.
- `--vs rivals/v1` plays against a saved rival, a folder holding that version's `agent.py` and `manifest.json`. It also works with `human` and `eval`.
- `eval` reports a higher-is-better team score, useful for comparing changes against the same seeds, not for predicting leaderboard results.
- `play --preset season_3` runs with one season's full settings directly. `season.json`, which arrives with your assignment, applies those settings automatically instead once you have it.

The [getting started guide]({{DOCS_URL}}students/getting-started/) explains manual virtual-environment setup and the GitHub workflow.

## Write the agent

Open `agent.py` and implement:

- `reset(seed)`, called once before each match.
- `act(observation)`, called on your unit's turn. `observation` is a dict with `observation` and `action_mask` keys. Return a dict with a `path` and a `target` choice, built with the `move()` and `stay()` helpers in `sandbox.crane`.

Read [`environment.md`](environment.md) before you start. It explains the starter agent, the observation, the action mask, the `sandbox.crane` helpers, and messaging.

Two optional methods are available. The [agent interface reference]({{DOCS_URL}}students/agent-interface/) covers both in full:

- `learn(observation, action, reward, terminated)` updates a learning agent after a step.
- `chat(inbox)` sends and receives messages. Crane Reach turns messaging on from Season 3 onward, and `agent.py` includes a commented-out `chat` hook to start from.

Leave an optional method out when you do not use it.

The template marches toward the mirror of its spawn tile until an enemy comes into view, then walks one step at a time toward the nearest one and names it. `TODO(you)` in `act` marks where to improve it. Every unit on your side runs its own separately constructed `Agent` instance, so nothing you store on `self` carries over between your units.

## Submit

Submit the repository URL through the course website. Game Sandbox pins one commit, and a later submission replaces it while the season is open. The [submitting guide]({{DOCS_URL}}students/submitting/) covers validation and common errors.

## LLM availability

Skirmish at Crane Reach does not enable model calls. The composed starter still includes `python -m sandbox llm` and the shared [Using the LLM API](llm.md) reference, which report the availability configured for an environment.
