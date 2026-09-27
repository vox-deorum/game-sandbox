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

On every tick, each villager asks `assign` in `agent.py` what to do right now. The answer is a routine name and a goal, such as `("tend", "stall_2")`. The villager then runs that routine from `routines.py`, which returns the action for this tick.

- `agent.py` holds the schedule. The `ROLES` table says what each kind of resident does in each phase of the day (dawn, morning, midday, evening, and night) and how it reacts to the visitor. The `RESIDENTS` table gives each of the ten villagers its role choices, its own work prop, and the time it walks home. `assign` reads both tables.
- `routines.py` holds the routines, such as `go_to`, `tend`, `gather_at`, `greet`, and `sleep_at`. Each one returns an action for this tick, or `None` when it cannot do its job right now. On `None`, the villager wanders toward its goal instead.
- `dialogue.py` answers the latest thing the visitor said. It uses the optional LLM API in the background, so a routine tick never waits for it. It only replies while the visitor can still hear, and falls back to a canned line when the request cannot run.
- `tests/test_neighbor.py` checks each routine on constructed observations, the visitor reaction, the dialogue fallbacks, and a full Season 4 day in which every resident moves, works, and ends up asleep at home.

Each villager keeps its own memory dictionary, because every villager runs in a separate `Agent` instance. When the visitor comes within hearing range, a villager reacts once for 40 ticks (greeting, following, or avoiding them), then goes back to its schedule until the visitor leaves and returns.

> _How does `go_to` find its way?_ In `reset`, `build_graph` turns every walkable cell of the village into a graph node, using `layout.walkable`, `layout.can_step`, and `layout.ground_at`. On each tick, `go_to` searches that graph with [A\* search](https://en.wikipedia.org/wiki/A*_search_algorithm). You may change how the graph is built or replace the route finder.

## Your assignment

The schedule never adapts: every resident follows the same table every day. Replace it with your own village story. Decide who should do what, where, and when those choices should change as the day and the visitor move around them.

A good order to work in:

1. **Change the tables.** Edit `ROLES` and `RESIDENTS` in `agent.py` to move people around the village without touching any logic. Run `python -m sandbox watch --preset season_4` to see the result.
2. **Rewrite `assign`.** It runs on every tick, and a villager switches plans whenever its answer changes. Its checks run in priority order, so night comes first and the ordinary schedule comes last. Add your own checks, such as reacting to the bell with `day.bell_ringing(observation)`.
3. **Add routines.** Write a function in `routines.py` with the same `(observation, memory, goal)` shape as the others, then return its name from `assign`. The comment at the top of `routines.py` explains the shape. Tunable numbers, such as how far `follow` stays back, sit near the top of that file.
4. **Change how villagers talk.** `_messages` in `dialogue.py` writes the prompt that the LLM sees. Give it more of the observation to talk about.

Run `python -m sandbox test` after each change. The provided tests check the example as shipped, so update or replace a test when you deliberately change the behavior it checks.

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
