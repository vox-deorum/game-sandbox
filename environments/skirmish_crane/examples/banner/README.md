# Skirmish at Crane Reach: Banner agent

Banner is the Season 4 starting point: a library of tactical blocks and a side that assigns every unit one block and one goal. This branch is already a runnable agent repository. Edit `blocks.py` and `agent.py` directly.

Start with the [Getting Started guide]({{DOCS_URL}}students/getting-started/). Then run these commands from this folder:

```console
python -m sandbox play   # command a side yourself in your browser
python -m sandbox watch  # watch Banner take on Naive
python -m sandbox test   # run the provided checks
python -m sandbox eval   # compare Banner with Naive
```

**Naive** is a simple built-in opponent. It holds the other side in `watch` and `eval`, and `eval` reports Banner's average team score over repeatable matches. The [`environment.md`](environment.md) guide explains rivals, presets, and the other command options.

## How Banner works

- `blocks.py` holds ten tactical blocks and `assign`, which hands each unit one block and one goal. Every block reads the action mask and scores the tiles the unit could finish on, so its order is legal by construction.
- `agent.py` runs the assigned block and advances toward its goal when that block has nothing to say.
- `tests/test_banner.py` checks each block on constructed activations, exercises mask legality across whole matches, and compares Banner with the Naive agent on pinned Season 4 seeds.

`assign` is the placeholder Season 4 asks you to replace. It commits every unit to one job in round one and never reconsiders. Your assignment is to decide who should do what and where, and when those choices should change as the battle turns. You may also edit, extend, or replace the tactical blocks.

## Files you will use

| Path | Purpose |
| --- | --- |
| `agent.py` | Runs the tactical block assigned to one unit. |
| `blocks.py` | Defines Banner's tactical blocks and assignment policy. |
| `environment.md` | Explains the Crane rules, helpers, observations, and settings. |
| `manifest.json` | Names the agent class for a submission. |
| `season.json` | Holds optional local season settings downloaded from My Submissions. |
| `tests/` | Contains the checks your submission should pass. |
| `sandbox/` | Provides the local game, commands, helpers, and observation types. Do not edit it. |

Leave `sandbox/`, `requirements.in`, and `requirements.txt` unchanged. The pinned packages match the server. Ask your instructor before adding a package.

When your agent is ready, follow the shared [submitting guide]({{DOCS_URL}}students/submitting/). For the optional `learn` and `chat` hooks, see the shared [agent interface]({{DOCS_URL}}students/agent-interface/). Crane messaging begins in Season 3.

## Optional LLM API

If your instructor enables model calls, follow [Using the LLM API](llm.md). Copy `.env.example` to `.env`, add the endpoint and key, and never commit either secret.

Test the connection with:

```console
python -m sandbox llm
```
