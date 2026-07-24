# Environments

Every environment exposes a [PettingZoo](https://pettingzoo.farama.org/) interface. Native multi-agent games implement this interface directly. A general compatibility wrapper presents a single-agent Gymnasium game as a one-slot PettingZoo environment.

The rest of the system therefore sees one shape:

```text
Gymnasium game → single-agent wrapper ┐
                                      ├→ PettingZoo interface → session harness
Native multi-agent game ──────────────┘
```

Every environment accepts a seed on reset so controlled repetitions can be compared. See [Leaderboards](leaderboard.md).

## Metadata layers

Metadata has two layers:

| Layer | Examples | Used by |
| --- | --- | --- |
| PettingZoo | Action space, observation space, agent IDs, rewards | Agent and environment loop |
| Game Sandbox | Display text, slot counts, human slots, timing, capabilities, renderer | Website, scheduler, session controls |

Game Sandbox metadata includes:

- Display name and description.
- Minimum and maximum slots.
- Typed gameplay parameter declarations and their environment defaults.
- Human-capable slots and their default timeout.
- Recommended episode length.
- Pace interval, or no interval for turn-based play.
- Default step and episode compute limits.
- Messaging availability and message cap.
- LLM API availability.
- Whether seat order changes the game.
- Renderer identifier.

A season may override the gameplay parameter, timing, messaging, and LLM defaults. See [Leaderboards](leaderboard.md).

The **pace interval** is the only distinction between real-time and turn-based stepping. When an interval is set, the environment advances on a wall-clock schedule. With no interval, it advances when the acting slot provides an action. See [Interaction](interaction.md).

**Seat order** records whether swapping two agents between seats creates a meaningfully different game. A positional game enables this setting. For example, in a trick-taking card game where play follows a fixed order, seating agent A before B differs from seating B before A. A symmetric game leaves it disabled because only the set of participants matters. The leaderboard scheduler reads this field when it expands a match design across submissions. See [Leaderboards](leaderboard.md).

## Configurable gameplay parameters

An environment may declare gameplay parameters beside its metadata. Each declaration has a stable snake_case name, a friendly title and description, a type, and an environment default. Integer and float parameters may set inclusive bounds. Choice and multi-choice parameters declare non-empty string values with friendly labels.

The supported parameter types are:

- `int`: a JSON-safe integer. Booleans are not integers.
- `float`: a finite number. Integers normalize to floats, and booleans are rejected.
- `string`: any string, including an empty string.
- `bool`: a boolean value.
- `choice`: one declared string value.
- `multi_choice`: a unique list of declared string values, normalized to declaration order. An empty list is valid.

Every environment also has a synthesized `seats` integer parameter. Its minimum and maximum come from `min_slots` and `max_slots`, and its default is `max_slots`. Environments cannot declare another parameter named `seats`. Slot bounds remain the source of truth, so the parameter cannot drift from the existing scheduling and validation contract.

Parameter values resolve in layers:

1. Environment defaults.
2. The play-open or automated-run season's overrides.
3. Player tweaks for one live watch or play session.

Automated games stop after the second layer. They always use the season values. Every resolved map contains exactly the environment's effective parameter names, including `seats`.

An environment factory receives the complete resolved parameter map. A variable-seat environment uses `parameters["seats"]` to size `possible_agents`, and the harness verifies the resulting count after reset. Existing environments remain fixed-seat. How a future variable-seat environment combines seat changes with scheduler Naive fill and `human_slots` is intentionally left open until the first such environment is designed.

The website hides numeric parameters whose minimum equals their maximum and single-choice parameters with one option. A non-empty multi-choice parameter remains visible because choosing none and choosing its one option are distinct values.

## Observations and actions

The platform convention uses an **object-shaped observation** and a simple **`Discrete` action space**. Observations contain meaningful game values instead of packed integer arrays that agents must decode. For example, a card is an object with `{"suit", "rank"}`, a hand is a sequence of card objects, and a Flappy Bird observation describes the bird and pipes as coordinate objects. Every observation must satisfy its declared Gymnasium space throughout a complete episode.

An environment whose legal actions depend on state publishes a top-level binary **`action_mask`** beside the observation. It wraps the meaningful state as `{"observation": {…}, "action_mask": …}`, which places the mask where PettingZoo's masked sampling expects it. Hearts and Spades use a mask to mark the currently legal cards and bids. Flappy Bird has no mask because idle and flap are always legal while its agent is active. The mask is the single authority on legality. A renderer uses it to grey out illegal choices instead of calculating the rules again.

Actions remain flat integers accepted by a `Discrete` space. `env.step()` validates each integer and rejects illegal actions. A flat `Discrete` action keeps the mask effective because Gymnasium supports masked sampling for `Discrete` spaces. A composite `Dict` or `OneOf` action space could sample outside the legal set. Template helpers convert a meaningful choice, such as a card or bid, into the integer accepted by the action space, so agents do not have to construct the index themselves.

### PettingZoo conformance and the api_test #1211 bug

Every environment passes PettingZoo's `api_test`, and `observation_space.contains()` validates the full composite observation throughout an episode. Pinned version 1.26.1 has one known open bug, [PettingZoo #1211](https://github.com/Farama-Foundation/PettingZoo/issues/1211). For a composite inner `observation`, `api_test` reads `observation_space(agent)["observation"].dtype` and raises `AttributeError: 'dict' object has no attribute 'dtype'` with two related `UserWarnings`. A documented CI guard tolerates exactly this error and raises every other error as a genuine conformance failure. The guard will be removed after an upstream release fixes the bug.

## Environments in the system

The first environment is a Flappy Bird-style single-agent game that uses the compatibility wrapper. It declares a `pipe_gap` integer parameter with a default of 100 and an inclusive range from 60 to 200. The first native multi-agent environment is Hearts, a four-slot, turn-based trick-taking card game implemented directly against PettingZoo. Spades follows as the first environment to enable agent messaging. It is a four-slot partnership trick-taking game in which players seated across the table are partners and share a team score. All three environments use the same registry and session loop. The same machinery therefore runs both a single paced slot and four sequential turn-based slots, including a human slot seated among agents.
