# Environments

This specification defines the environment interface: players and seats, metadata, the stepping contract, configurable gameplay parameters, and the observation and action shape.

Every environment exposes a [PettingZoo](https://pettingzoo.farama.org/) interface. Native multi-agent games implement this interface directly. A general compatibility wrapper presents a single-agent Gymnasium game as a one-player PettingZoo environment.

The rest of the system therefore sees one shape:

```text
Gymnasium game → single-agent wrapper ┐
                                      ├→ PettingZoo interface → session harness
Native multi-agent game ──────────────┘
```

Every environment accepts a seed on reset so controlled repetitions can be compared. See [Leaderboards](leaderboard.md).

## Players and seats

A **player** is one PettingZoo position, identified as `player_N`. The environment steps, observes, and scores players. A **seat**, identified as `seat_N`, is the unit assigned to a controller, scheduled, and ranked. It covers one or more players.

| Layout declaration | Seats and player count |
| --- | --- |
| **Player bounds** | Every player has its own seat. The canonical layout is `solo`, and the `players` parameter selects a count within the declared bounds. |
| **Seat plans** | Each named plan lists seat declarations and the players they cover. It is a complete partition of its players, and the selected plan determines the player count. |

An environment declares exactly one layout form: player bounds or seat plans, never both. Plans in one environment may cover different player counts, so an environment with wider or uneven seats declares each supported layout as its own plan. Seat membership never depends on live state.

A seat's score is the mean of its players' final scores. The environment defines player scores. For example, both Spades partners receive their partnership score, while independently scored players contribute their own. This keeps scores comparable across seat widths.

### Builtin agents and restricted seats

A seat plan can reserve one seat for a scripted opponent that participants play against rather than compete through. Every environment declares an ordered, nonempty set of builtin agents. Each builtin has a unique snake_case name and a nonempty display label. `naive` is always the first declaration and is the common baseline that automated schedules use to fill submission positions.

Each seat declaration in a plan lists its nonempty ordered player indexes and may name one `restricted_builtin`. At most one seat in a plan may set this field, the name must identify a builtin declared by the same environment, and at least one other seat in the plan must remain unrestricted. A **restricted seat** accepts its designated builtin, or a human when one of its players is human-capable. It never accepts a submission or another builtin.

Player-bounds layouts synthesize interchangeable seats and cannot restrict one of them. Resolving any layout puts the nullable restricted-builtin name on each seat, so scheduling, live sessions, and the website consume the same authoritative shape.

### Per-player agent instances

In watch and automated play, one selected agent is assigned to a seat and serves every player it covers. Each agent-controlled player receives a separately constructed instance of that agent. The same applies to every nonhuman seat member controlled by a companion agent. A self-played wide human seat has no companion instances. The platform provides no combined multi-player object or shared-state API. An environment that needs one agent to reason over several units must expose them through one player's observation and action. [Interaction](interaction.md#human-play) defines human and companion assignment, and [Execution](execution.md#from-submission-to-image) defines how submissions are staged for those instances.

### Choosing a layout

A season or live-session player selects from the environment's supported layouts. Under player bounds, that selection is the player count. Under seat plans, it is the plan key. The website, scheduler, and season configuration can therefore resolve the full seat map before constructing the environment.

### Seat order

**Seat order** records whether swapping two agents between seats creates a meaningfully different game. A positional game enables this setting. For example, in a trick-taking card game where play follows a fixed order, seating agent A before B differs from seating B before A. A symmetric game leaves it disabled because only the set of participants matters. The leaderboard scheduler reads this field when it expands a match design across submissions, enumerating over seats rather than players. See [Leaderboards](leaderboard.md#automated-board).

## Metadata layers

Metadata has two layers:

| Layer | Examples | Used by |
| --- | --- | --- |
| PettingZoo | Action space, observation space, agent IDs, rewards | Agent and environment loop |
| Game Sandbox | Display text, player counts, seat plans, human-capable players, timing, capabilities, renderer | Website, scheduler, session controls |

Game Sandbox metadata includes:

- Display name and description.
- Either minimum and maximum players, or the seat plans a season may choose between.
- The ordered named builtin agents available to seats.
- Typed gameplay parameter declarations and their environment defaults.
- Human-capable players and their default timeout.
- Recommended episode length.
- Required stepping mode: `sequential` or `simultaneous`.
- Pace interval, or no interval for turn-based play.
- Viewing cadence for watch and replay playback, independent of the pace interval.
- Live playout cadence for the other players' moves in a turn-based session with a human player.
- Default step and episode compute limits.
- Messaging availability and message cap.
- LLM API availability.
- Whether seat order changes the game.
- Renderer identifier.

A season may override gameplay parameters, step and episode compute limits, messaging, and LLM defaults. See [Seasons](seasons.md#per-season-configuration).

A messaging environment may also implement the optional live-state recipient hook described in [Communication](communication.md). The hook belongs to the running environment because it may inspect current game state. It is not serialized in environment metadata.

## Stepping contract

Every environment declares `stepping` in its metadata. The declaration is required and has no fallback value.

| Stepping mode | Factory result | PettingZoo conformance |
| --- | --- | --- |
| `sequential` | An AEC (Agent Environment Cycle) environment with `agent_selection`, `last()`, and scalar `step(action)`. | `api_test` |
| `simultaneous` | A parallel environment whose `reset()` returns observation and info mappings, and whose `step(actions)` accepts and returns player-keyed mappings. | `parallel_api_test` |

The **pace interval** sets the cadence within an environment's declared stepping mode. A sequential environment with an interval advances on a wall-clock schedule, and without one it advances when its acting player provides an action. A simultaneous environment always declares a positive interval; [Interaction](interaction.md#session-loop) defines how that interval becomes each human player's input window.

The **viewing cadence** is the optional pace for watch and replay playback, independent of the pace interval. The **live playout cadence** is the optional pace at which a live turn-based session with a human plays out the other players' moves one at a time. Neither affects stepping, timing budgets, or scoring.

The harness creates the environment only after it resolves the session parameters. It checks the constructed instance against the declared mode before participant reset, recording creation, or live stepping. Discovery does not construct an environment, because default parameters can describe a different roster from the selected layout.

Parallel environments use a stricter subset of the PettingZoo parallel API. After reset, `env.agents`, observations, and infos exactly cover the resolved players in canonical order. The active set only shrinks. Each joint action and every returned observation, reward, termination, truncation, and info mapping exactly cover the players active before that step. After a step, `env.agents` is the canonical nonterminal subsequence of that earlier active set.

## Configurable gameplay parameters

An environment may declare gameplay parameters beside its metadata. Each declaration has a stable snake_case name, a friendly title and description, a type, and an environment default. Integer and float parameters may set inclusive bounds. Choice and multi-choice parameters declare nonempty string values with friendly labels.

### Parameter types

The supported parameter types are:

- `int`: a JSON-safe integer. Booleans are not integers.
- `float`: a finite number. Integers normalize to floats, and booleans are rejected.
- `string`: any string, including an empty string.
- `bool`: a boolean value.
- `choice`: one declared string value.
- `multi_choice`: a unique list of declared string values, normalized to declaration order. An empty list is valid.

### Reserved parameters

Every environment synthesizes exactly one reserved parameter from its layout declaration. Player bounds synthesize the `players` integer parameter, bounded by the declared `min` and `max` and defaulting to `max`. Seat plans synthesize the `seat_plan` choice parameter, using plan keys as values and plan titles as labels, defaulting to the first declared plan. Environments cannot declare either name. Metadata remains the source of truth, so the parameter cannot drift from what scheduling and validation use. Every recording materializes the resolved seat-plan key and seat map for replay portability. See [Recording](recording.md) and [Frontend](frontend.md#watch-and-play-flows) for the configuration controls.

Two values are always derived rather than declared: the player count and the seat count. Under player bounds both are the resolved `players` value, since every player has its own seat. Under declared plans they are the number of players the resolved plan covers and the number of seats it lists. Every declared plan must have nonempty seats, and the player indexes across its seats must be exactly `0` through `N - 1`, each occurring once, where `N` is the number of players the plan covers. The platform checks this when it loads an environment.

### Resolving parameter values

Parameter values resolve in layers:

1. Environment defaults.
2. Overrides from the play-open season or the automated run's season.
3. Player tweaks for one live watch or play session.

Automated games stop after the second layer and always use the season values. Every resolved map contains exactly the environment's effective parameter names, including whichever of `players` and `seat_plan` that environment has.

A season override is validated when saved. If later environment declarations reject it, live sessions use the environment default and record the drift for the operator. An automated run refuses the drifted override, so it never freezes a value the operator did not choose.

An environment factory receives the complete resolved parameter map. A variable-player environment uses `parameters["players"]` to size `possible_agents`, and an environment with declared plans uses `parameters["seat_plan"]` and sizes `possible_agents` to the players that plan covers. The harness verifies the resulting count after reset either way. Existing environments have a fixed player count.

## Observations and actions

The platform convention is an **object-shaped observation** and a simple **`Discrete` action space**. Observations contain meaningful game values instead of packed integer arrays that agents must decode. For example, a card is an object with `{"suit", "rank"}`, a hand is a sequence of card objects, and a Flappy Bird observation describes the bird and pipes as coordinate objects. Every observation must satisfy its declared Gymnasium space throughout a complete episode.

An environment whose legal actions depend on state publishes a top-level binary **`action_mask`** beside the agent observation. It wraps the meaningful state as `{"observation": {…}, "action_mask": …}`, which places the mask where PettingZoo's masked sampling expects it. The mask counts positions from the action space's `start`, so position `i` covers the action `start + i`, which for the usual space starting at zero is simply the action `i`. The mask is authoritative for agent legality. Human controls must offer the same legal choices, either listed in the semantic render overlay or derived by the renderer from the overlay's game state. Hearts and Spades provide both the mask and the overlay. Flappy Bird needs neither because idle and flap are always legal while its agent is active.

Every current environment uses a flat integer action accepted by a `Discrete` space. `env.step()` validates each integer and rejects illegal actions. Template helpers convert a meaningful choice, such as a card or bid, into the integer accepted by the action space.

### Composite actions

An environment may declare a `Dict` action space when one action is genuinely several independent choices. An action is then an object with one value per declared key, and the `action_mask` is an object carrying one entry per declared key. An entry of `null` marks that component as unrestricted for the turn. A `Dict` child may itself be one of a small set of permitted types, each with its own mask entry shape:

| Child subspace | Mask entry shape |
| --- | --- |
| `Discrete(n, start=s)` | a binary vector of length `n`. Position `i` covers the action `s + i`. |
| `MultiDiscrete(nvec, start=starts)` | a tuple of binary vectors, one per dimension. Vector `i` has length `nvec[i]`, and its position `j` covers the value `starts[i] + j`. `nvec` must be one-dimensional. |
| a nested `Dict` | an object under these same rules, one entry per its own declared key. |
| `Box` | always `null`, because a continuous range cannot be masked. |

`MultiBinary` and `Tuple` children are not permitted. `MultiBinary(k)` describes the same choice set as a `MultiDiscrete` with two values per dimension, so declare that instead. A `Tuple` is a `Dict` without names, and the platform's convention is named components everywhere, so declare a `Dict` with one key per component instead. Keeping to one mask vocabulary means a `1` always marks a legal choice, with no second dialect to learn.

A `Dict` action space is permitted only when the legal action set is exactly the product of the per-key legal sets. Masked sampling draws one value per key and combines them, so it covers exactly that product. If any combination of individually legal values is illegal, the mask stops being authoritative and a masked sample can produce a move the environment rejects.

| Action space | Mask on one turn | Permitted |
| --- | --- | --- |
| `{"kind": Discrete(2), "index": Discrete(52)}` | `kind` pinned to the bidding phase, `index` over the legal bids | Yes |
| `{"suit": Discrete(4), "rank": Discrete(13)}` | `suit` over the held suits, `rank` over the held ranks | No |

The first factorizes. Pinning `kind` to the current phase leaves `index` free, so every combination the mask allows is a legal move.

The second does not. A hand of the two of clubs and the nine of spades masks in the suits `{clubs, spades}` and the ranks `{two, nine}`, so masked sampling can draw the two of spades, which is not held. Encode a choice like this as a flat `Discrete` over the joint options, or as a single `Dict` key whose values enumerate them, so the mask keeps describing exactly the legal moves.

The harness applies the same rule when it checks an agent's action. It judges each key against that key's mask entry. It does not judge a key the mask leaves out, a key set to `null`, or an action whose shape disagrees with the mask's. A mask entry the platform cannot read withholds the legality verdict for that key alone: the other keys are still judged, the acting player is never charged for it, and the session never aborts over it, because an unreadable entry is the environment's defect.

### PettingZoo conformance

Beyond the declared mode's API test, the shared conformance suite runs a deterministic rollout, validates each observation and legal default action, and checks that overlays are finite and JSON-safe. `observation_space.contains()` validates the full composite observation throughout an episode. On every turn of that rollout, the suite also checks that the published `action_mask` agrees in shape with the declared action space, and that a `Dict` action space declares only the permitted child types above.

A `Dict` action space is supported for sequential environments only. PettingZoo's `parallel_api_test` reduces an action mask with `np.flatnonzero` before sampling, which is meaningless for an object mask, so a simultaneous environment with a `Dict` action space cannot pass conformance on the pinned PettingZoo version. The correction is merged upstream and has not reached a release. The sequential `api_test` samples through the action space itself and handles an object mask correctly.

An action is recorded as the environment received it. NumPy scalars and arrays normalize to plain JSON values on the way into a recording, and any other value a recording cannot represent fails the write.
