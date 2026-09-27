# Days at Three Branches: Neighbor agent

Neighbor is the Season 4 starting point: ten residents who leave home, work across the village, gather at midday, light props in the evening, return home, and sleep at night. This branch is already a runnable agent repository. Edit `agent.py`, `routines.py`, and `dialogue.py` directly.

Start with the [Getting Started guide]({{DOCS_URL}}students/getting-started/). Then run these commands from this folder:

```console
python -m sandbox watch --preset season_4  # watch Neighbor's day beside the scripted visitor
python -m sandbox play --preset season_4   # walk through the village as the visitor yourself
python -m sandbox test                     # run the provided checks
python -m sandbox eval                     # run repeatable automated days
```

The `season_4` preset runs ten villagers with day and night on. The [`environment.md`](environment.md) guide explains presets, the visitor, and the other command options.

## How Neighbor works

- `agent.py` gives each villager a role from a static role table and picks a routine and goal for each phase of the day: dawn, morning, midday, evening, and night. It revisits that choice at phase boundaries and when the visitor comes near.
- `routines.py` holds the routines, such as `go_to`, `tend`, `gather_at`, `greet`, and `sleep_at`. Each one returns an action for this tick, or `None` when it has nothing to do.
- `dialogue.py` answers the latest thing the visitor said, using the optional LLM API in the background so a routine tick never waits for it. It only replies while the visitor can still hear, and falls back to a canned line when the request cannot run.
- `tests/test_neighbor.py` checks each routine on constructed observations, the dialogue fallbacks, and a full Season 4 day in which every resident moves, works, and ends up asleep at home.

Each villager keeps its own memory dictionary, because every villager runs in a separate `Agent` instance. Lanterns do not appear in every village, so a lantern-tender with no lantern goes back to that resident's own work prop for the evening.

### Routing

`build_graph` makes a graph of every walkable village cell once in `reset`, using `layout.walkable`, `layout.can_step`, and `layout.ground_at`. `go_to` then searches that cached graph on each tick. You may change the cell resolution or replace the route finder.

## Your assignment

The schedule never adapts: every resident follows the same table every day. `assign` in `agent.py` is a starting place to replace with a different village story. Decide who should do what, where, and when those choices should change as the day and the visitor move around them. You may also edit, extend, or replace the routines to make them more like your style.

## Files you will use

| Path | Purpose |
| --- | --- |
| `agent.py` | Assigns each villager a routine and goal, then runs it. |
| `routines.py` | Defines Neighbor's routines and the cached route graph. |
| `dialogue.py` | Replies to the visitor without blocking a routine tick. |
| `environment.md` | Explains the village rules, helpers, observations, and settings. |
| `manifest.json` | Names the agent class for a submission. |
| `season.json` | Holds optional local season settings downloaded from My Submissions. |
| `tests/` | Contains the checks your submission should pass. |
| `sandbox/` | Provides the local game, commands, helpers, and observation types. Do not edit it. |

Leave `sandbox/`, `requirements.in`, and `requirements.txt` unchanged. The pinned packages match the server. Ask your instructor before adding a package.

When your agent is ready, follow the shared [submitting guide]({{DOCS_URL}}students/submitting/). For the optional `learn` and `chat` hooks, see the shared [agent interface]({{DOCS_URL}}students/agent-interface/).

## Optional LLM API

If your instructor enables model calls, follow [Using the LLM API](llm.md). Copy `.env.example` to `.env`, add the endpoint and key, and never commit either secret.

Test the connection with:

```console
python -m sandbox llm
```
