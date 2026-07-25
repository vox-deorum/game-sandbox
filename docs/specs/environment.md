# Environments

Every environment exposes a [PettingZoo](https://pettingzoo.farama.org/) interface. Native multi-agent games implement this interface directly. A general compatibility wrapper presents a single-agent Gymnasium game as a one-player PettingZoo environment.

The rest of the system therefore sees one shape:

```text
Gymnasium game → single-agent wrapper ┐
                                      ├→ PettingZoo interface → session harness
Native multi-agent game ──────────────┘
```

Every environment accepts a seed on reset so controlled repetitions can be compared. See [Leaderboards](leaderboard.md).

## Players and seats

A **player** is one PettingZoo position, identified as `player_N`. It is the unit the environment steps, observes, and scores.

A **seat** is the assignable and scored unit, identified as `seat_N`. A seat covers one or more players. In watch and automated play, one selected agent is bound across all of its players. In human play, one human-capable member is controlled by the person and one selected companion agent drives every other member. The leaderboard scheduler enumerates seats and the boards score them. Where every seat covers a single player, as in Hearts and Flappy Bird, the player and seat are the same thing.

A seat's score is the mean of its players' scores. The environment reports one score per player as it always has, and it decides how those player scores relate. Spades gives both partners their partnership score, so their mean is that partnership score. A game that scores each unit on its own contribution gives a seat the average of its units. Taking the mean keeps scores comparable across seat widths, so one board can rank a seat of ten players beside a seat of one.

Every agent-controlled player in a seat runs a separately constructed instance of that seat's selected agent. The same rule applies to a companion selected for a human seat: each nonhuman member gets its own instance. The platform supplies no combined multi-player object or shared-state API for those instances, although ordinary shared-container and process-isolation limits still apply. An environment that wants one agent reasoning over several units at once therefore gives that agent a single player whose observation and action cover them all, rather than expecting the platform to join them.

An environment describes its seats in one of two ways, and never both.

Most environments declare **player bounds** and nothing else. Every player then gets a seat of its own, which is the canonical `solo` plan, and the player count is an ordinary gameplay parameter that a season or a player may vary within those bounds. Flappy Bird and Hearts work this way and declare nothing new.

An environment that needs wider or uneven seats declares **seat plans** instead. A plan has a key, a title, and its seats, where each seat names the players it covers, so a plan is a complete partition of the players that plan uses. The player count is then derived from the chosen plan rather than chosen separately. Spades declares two plans: `partnership`, whose two seats hold players 0 and 2, and 1 and 3, and `solo`, whose four seats hold one player each. A role-playing environment declares a plan whose seats are deliberately uneven, such as one seat for the hero, one for ten villagers, and one for ten monsters.

Plans in one environment need not cover the same number of players, so an environment that wants several player counts expresses each as its own plan. What an environment cannot do is declare free player bounds and static plans at once, because a plan that names player 3 means nothing in a two-player game. Deriving the count from the plan is what makes that combination unrepresentable rather than merely discouraged.

Seats within a plan need not be the same width. Naming the players of each seat, rather than deriving them from a rule, is what lets a partnership seated across the table and an uneven cast of characters share one declaration.

A season, or a player starting a session, chooses among the declared plans. Seat membership therefore never depends on live state, which matters because the website, the scheduler, and season configuration all need to know it before an environment instance exists.

## Metadata layers

Metadata has two layers:

| Layer | Examples | Used by |
| --- | --- | --- |
| PettingZoo | Action space, observation space, agent IDs, rewards | Agent and environment loop |
| Game Sandbox | Display text, player counts, seat plans, human-capable players, timing, capabilities, renderer | Website, scheduler, session controls |

Game Sandbox metadata includes:

- Display name and description.
- Either minimum and maximum players, or the seat plans a season may choose between.
- Typed gameplay parameter declarations and their environment defaults.
- Human-capable players and their default timeout.
- Recommended episode length.
- Pace interval, or no interval for turn-based play.
- Default step and episode compute limits.
- Messaging availability and message cap.
- LLM API availability.
- Whether seat order changes the game.
- Renderer identifier.

A season may override the gameplay parameter, timing, messaging, and LLM defaults. See [Leaderboards](leaderboard.md).

A messaging environment may also implement the optional live-state recipient hook described in [Communication](communication.md). The hook belongs to the running environment because it may inspect current game state. It is not serialized in environment metadata.

The **pace interval** is the only distinction between real-time and turn-based stepping. When an interval is set, the environment advances on a wall-clock schedule. With no interval, it advances when the acting player provides an action. See [Interaction](interaction.md).

**Seat order** records whether swapping two agents between seats creates a meaningfully different game. A positional game enables this setting. For example, in a trick-taking card game where play follows a fixed order, seating agent A before B differs from seating B before A. A symmetric game leaves it disabled because only the set of participants matters. The leaderboard scheduler reads this field when it expands a match design across submissions, enumerating over seats rather than players. See [Leaderboards](leaderboard.md).

## Configurable gameplay parameters

An environment may declare gameplay parameters beside its metadata. Each declaration has a stable snake_case name, a friendly title and description, a type, and an environment default. Integer and float parameters may set inclusive bounds. Choice and multi-choice parameters declare non-empty string values with friendly labels.

The supported parameter types are:

- `int`: a JSON-safe integer. Booleans are not integers.
- `float`: a finite number. Integers normalize to floats, and booleans are rejected.
- `string`: any string, including an empty string.
- `bool`: a boolean value.
- `choice`: one declared string value.
- `multi_choice`: a unique list of declared string values, normalized to declaration order. An empty list is valid.

Every environment also has exactly one synthesized reserved parameter, matching the way it describes its seats. An environment with player bounds gets the `players` integer parameter, bounded by `min_players` and `max_players` and defaulting to `max_players`. An environment with declared seat plans gets the `seat_plan` choice parameter, whose values are the plan keys and whose labels are their titles, defaulting to the first declared plan. Environments cannot declare a parameter of either name. The metadata remains the source of truth for both, so neither can drift from the existing scheduling and validation contract. An environment with a single seat plan has a one-option choice, which the website hides like any other. A recording may materialize both resolved layout values for replay portability, but only the parameter that matches the environment's declaration is editable.

Two values are always derived rather than declared: the player count and the seat count. Under player bounds both are the resolved `players` value, since every player has its own seat. Under declared plans they are the number of players the resolved plan covers and the number of seats it lists. Every declared plan must have nonempty seats, and its indices must form the exact zero-based range from `0` through `N - 1`, where `N` is the number of distinct players in the plan, with each index occurring once. The platform checks this when it loads an environment rather than when a session starts, so a session can never resolve to a plan with a gap, a nonzero start, an unowned player, or a player assigned to two seats.

Parameter values resolve in layers:

1. Environment defaults.
2. The play-open or automated-run season's overrides.
3. Player tweaks for one live watch or play session.

Automated games stop after the second layer. They always use the season values. Every resolved map contains exactly the environment's effective parameter names, including whichever of `players` and `seat_plan` that environment has.

A season override is checked against the environment's declarations when an operator saves it, and is not rechecked afterwards. An environment whose declarations later change can therefore leave a stored override that the current declarations reject. Such an override falls back to the environment default, so resolution always produces a complete, usable map. The public prefill serves those values and the platform records the drift for the operator, rather than reporting a configuration problem to a player or taking the environment out of play. Creating an automated run refuses the drifted override instead, because a run would otherwise freeze values the operator never chose.

An environment factory receives the complete resolved parameter map. A variable-player environment uses `parameters["players"]` to size `possible_agents`, and an environment with declared plans uses `parameters["seat_plan"]` and sizes `possible_agents` to the players that plan covers. The harness verifies the resulting count after reset either way. Existing environments have a fixed player count. How a future variable-player environment combines player-count changes with scheduler Naive fill and `human_players` is intentionally left open until the first such environment is designed.

The website hides numeric parameters whose minimum equals their maximum and single-choice parameters with one option. A non-empty multi-choice parameter remains visible because choosing none and choosing its one option are distinct values.

## Observations and actions

The platform convention uses an **object-shaped observation** and a simple **`Discrete` action space**. Observations contain meaningful game values instead of packed integer arrays that agents must decode. For example, a card is an object with `{"suit", "rank"}`, a hand is a sequence of card objects, and a Flappy Bird observation describes the bird and pipes as coordinate objects. Every observation must satisfy its declared Gymnasium space throughout a complete episode.

An environment whose legal actions depend on state publishes a top-level binary **`action_mask`** beside the observation. It wraps the meaningful state as `{"observation": {…}, "action_mask": …}`, which places the mask where PettingZoo's masked sampling expects it. Hearts and Spades use a mask to mark the currently legal cards and bids. Flappy Bird has no mask because idle and flap are always legal while its agent is active. The mask is the single authority on legality. A renderer uses it to grey out illegal choices instead of calculating the rules again.

Actions remain flat integers accepted by a `Discrete` space. `env.step()` validates each integer and rejects illegal actions. A flat `Discrete` action keeps the mask effective because Gymnasium supports masked sampling for `Discrete` spaces. A composite `Dict` or `OneOf` action space could sample outside the legal set. Template helpers convert a meaningful choice, such as a card or bid, into the integer accepted by the action space, so agents do not have to construct the index themselves.

### PettingZoo conformance and the api_test #1211 bug

Every environment passes PettingZoo's `api_test`, and `observation_space.contains()` validates the full composite observation throughout an episode. Pinned version 1.26.1 has one known open bug, [PettingZoo #1211](https://github.com/Farama-Foundation/PettingZoo/issues/1211). For a composite inner `observation`, `api_test` reads `observation_space(agent)["observation"].dtype` and raises `AttributeError: 'dict' object has no attribute 'dtype'` with two related `UserWarnings`. A documented CI guard tolerates exactly this error and raises every other error as a genuine conformance failure. The guard will be removed after an upstream release fixes the bug.

## Environments in the system

The first environment is a Flappy Bird-style single-agent game that uses the compatibility wrapper. It declares a `pipe_gap` integer parameter with a default of 100 and an inclusive range from 60 to 200. The first native multi-agent environment is Hearts, a four-player, turn-based trick-taking card game implemented directly against PettingZoo. Spades follows as the first environment to enable agent messaging, and the first whose seats can cover more than one player. It is a four-player partnership trick-taking game in which players seated across the table are partners and share a team score. It declares two seat plans, `partnership` first and therefore by default, whose two seats each hold a partnership, and `solo`, whose four seats hold one player each. Flappy Bird and Hearts declare player bounds instead and get the canonical `solo` plan without naming it. All three environments use the same registry and session loop. The same machinery therefore runs a single paced player, four sequential turn-based players, and two seats that each cover two of them. In human partnership play, the person drives the first human-capable player in the selected seat and explicitly chooses the companion agent that drives the other.
