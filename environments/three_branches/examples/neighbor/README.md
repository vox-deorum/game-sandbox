# Days at Three Branches: Neighbor agent

Neighbor is the Season 4 starting point: ten residents who walk to work at dawn, work through the morning, meet at the inn at midday, work again in the evening, and walk home to sleep at night. They greet the visitor and say good day to each other. The day is deliberately plain. It shows how the pieces fit together, not what a good village looks like, which is yours to design. This branch is already a runnable agent repository. Edit `agent.py`, `routines.py`, `routing.py`, and `dialogue.py` directly.

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

- `agent.py` holds the schedule. The `RESIDENTS` table has one row per villager, saying which type of prop it works at and where it spends midday. `assign` reads the table and the day phase to pick the routine.
- `routines.py` holds the routines, such as `go_to`, `tend`, `gather_at`, `greet`, and `sleep_at`. Each one returns an action for this tick, or `None` when it cannot do its job right now. On `None`, the villager walks toward its goal with `go_to` instead. `wander`, `follow`, `avoid`, `rest`, and `watch` are there for you to use, although the plain day does not.
- `routing.py` finds walking paths for `go_to` with A\* search over a graph of the village's walkable cells.
- `dialogue.py` handles every conversation, with the visitor and between villagers. It answers the visitor through the optional LLM API in the background, so a routine tick never waits for it, and answers other villagers with canned lines.
- `tests/test_neighbor.py` checks each routine on constructed observations, the visitor reaction, finding a free work prop, both kinds of conversation, and a full Season 4 day in which every resident moves, works, and ends up asleep at home.

Each villager keeps its own memory dictionary, because every villager runs in a separate `Agent` instance. So villagers work things out for themselves instead of sharing a plan:

- **Where to work.** At reset, a villager lists every prop of its work type, nearest to its home first, and starts with the nearest. When its own use fails because someone else holds the prop, it moves on to the next one.
- **When to go home.** At night, a villager walks home. Inside, it heads for the middle of the room and lies down once it stands still, so its housemate can still get past the doorway.
- **The visitor.** When the visitor comes within hearing range, a villager greets them once, for 40 ticks, then goes back to its day until the visitor leaves and returns.

> _How does `go_to` find its way?_ In `reset`, `build_graph` in `routing.py` turns every walkable cell of the village into a graph node, using `layout.walkable`, `layout.can_step`, and `layout.ground_at`. `go_to` picks the walkable cell nearest its goal with `layout.nearest_walkable`, then asks `routing.path` for a route with [A\* search](https://en.wikipedia.org/wiki/A*_search_algorithm). You may change how the graph is built or replace the route finder.

### How villagers talk

Every line a villager hears goes through `Dialogue` in `dialogue.py`:

1. `receive` keeps each speaker's newest line waiting for an answer. A neighbor's line to everyone is only overheard, so a crowd does not all answer at once.
2. `messages` answers one waiting line per tick, the visitor's first. `scripted_answer` decides how: it returns a line to say right away, or `None` to ask the LLM.
3. An LLM answer arrives on a later tick. If the speaker walks away first, the answer is dropped.

A villager can also start a conversation with `say(player_id, text)`, or `say(None, text)` to speak to everyone in hearing range. At the midday meeting, `_small_talk` in `agent.py` uses it to say good day to the nearest neighbor, who answers with a canned line. `NEIGHBOR_TURNS` caps how many lines a villager says to one neighbor, so two villagers never answer each other forever.

Keep in mind who hears what. Watchers and replays show every line, but the visitor only sees lines sent to them and lines sent to everyone. A direct chat between two villagers is invisible to a visitor standing next to them.

## Your assignment

The day never adapts: every resident follows the same schedule every day. Replace it with your own village story. Decide who should do what, where, and when those choices should change as the day and the visitor move around them.

A good order to work in:

1. **Change the table.** Edit the rows of `RESIDENTS` in `agent.py`, for example to send some residents to a different building at midday. Run `python -m sandbox watch --preset season_4` to see the result.
2. **Add fields to the table.** Each field of `Resident` is one way residents can differ. To add one, give `Resident` a new field, fill it in on the rows, and read it in `assign`. For example, to give each resident its own reaction to the visitor:

   ```python
   class Resident(NamedTuple):
       work: str
       meet: str
       react: str = "greet"  # new: how this resident reacts to the visitor
   ```

   A field with a default, like `react` here, only needs a value on the rows that differ, such as `Resident(work="plot", meet="inn", react="follow")`. Then, in `assign`, return `resident.react, "player_0"` instead of `VISITOR_REACTION, "player_0"`. Fields can hold anything that helps you describe a resident: a persona, a favourite bench, a list of places to visit, or the tick they wake up.

3. **Rewrite `assign`.** It runs on every tick, and a villager switches plans whenever its answer changes. Its checks run in priority order, so night comes first and the ordinary schedule comes last. Add your own checks, such as reacting to the bell with `day.bell_ringing(observation)`.
4. **Add routines.** Write a function in `routines.py` with the same `(observation, memory, goal)` shape as the others, then return its name from `assign`. The comment at the top of `routines.py` explains the shape. Tunable numbers, such as how far `follow` stays back, sit near the top of that file.
5. **Change how villagers talk.** `scripted_answer` in `dialogue.py` chooses between a scripted line and an LLM answer, and `_messages` writes the prompt that the LLM sees. To let the LLM talk between villagers, return `None` from `scripted_answer` for them too. Ten villagers talking to each other can use up your budget and request-rate limit quickly (see [Using the LLM API](llm.md)), so keep `NEIGHBOR_TURNS` small. To start more conversations, call `self.dialogue.say` from `act`, as `_small_talk` does.

Run `python -m sandbox test` after each change. The provided tests check the example as shipped, so update or replace a test when you deliberately change the behavior it checks.

## Files you will use

| Path | Purpose |
| --- | --- |
| `agent.py` | Assigns each villager a routine and goal, then runs it. |
| `routines.py` | Defines Neighbor's routines. |
| `routing.py` | Builds the route graph and finds paths with A\* search. |
| `dialogue.py` | Talks with the visitor and other villagers without blocking a routine tick. |
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
