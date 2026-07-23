# Environments

Every environment exposes a [PettingZoo](https://pettingzoo.farama.org/) interface. Native multi-agent games implement it directly. A general compatibility wrapper lifts single-agent Gymnasium games into a one-slot PettingZoo environment.

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
- Human-capable slots and their default timeout.
- Recommended episode length.
- Pace interval, or no interval for turn-based play.
- Default step and episode compute limits.
- Messaging availability and message cap.
- LLM API availability.
- Whether seat order changes the game.
- Renderer identifier.

A season may override the timing, messaging, and LLM defaults. See [Leaderboards](leaderboard.md).

The **pace interval** is the only distinction between realtime and turn-based stepping. A set interval advances on a wall-clock cadence. No interval advances when the acting slot provides an action. See [Interaction](interaction.md).

**Seat order** records whether swapping two agents between seats yields a genuinely different game. A positional game, such as a trick-taking card game where play passes around a fixed order, sets it so that seating agent A before B is a different match than B before A. A symmetric game, where only the set of participants matters, leaves it off. The leaderboard scheduler reads this field when it expands a match design over submissions. See [Leaderboards](leaderboard.md).

## Observations and actions

The platform convention is an **object-shaped observation** and a simple **`Discrete` action space**. An observation carries meaningful game values (a card is an object `{"suit", "rank"}`, a hand is a sequence of those objects, Flappy Bird's is the bird and pipes as coordinate objects) rather than a packed integer array the agent must decode. Every observation still satisfies its declared Gymnasium space through a complete episode.

An environment whose legality depends on state publishes a top-level binary **`action_mask`** beside the observation, wrapping the semantic state as `{"observation": {…}, "action_mask": …}`, where PettingZoo's masked sampling expects the mask. Hearts and Spades carry a mask marking the currently legal cards and bids; Flappy Bird has none, because idle and flap are always legal while its agent is active. The mask is the single authority on legality, so a renderer greys illegal choices from it rather than re-deriving the rules.

Actions stay flat integers accepted by a `Discrete` space, and `env.step()` validates the integer and rejects an illegal one. A flat `Discrete` action keeps the mask effective: Gymnasium's masked sampling covers `Discrete` spaces, whereas a composite `Dict`/`OneOf` action space could sample outside the legal set. Helpers in the template turn a semantic choice, such as a card or a bid, into the integer the action space accepts, so agents don't have to build the index by hand.

### PettingZoo conformance and the api_test #1211 bug

Every environment passes PettingZoo's `api_test`, and `observation_space.contains()` validates the whole composite observation throughout an episode. The pinned PettingZoo 1.26.1 carries one known, open bug ([PettingZoo #1211](https://github.com/Farama-Foundation/PettingZoo/issues/1211)): for a composite inner `observation`, `api_test` evaluates `observation_space(agent)["observation"].dtype` and raises `AttributeError: 'dict' object has no attribute 'dtype'`, alongside two related `UserWarnings`. CI tolerates exactly that one error behind a documented guard and re-raises anything else as a genuine conformance failure. The guard is removed once a fixed PettingZoo ships upstream.

## Environments in the system

The first environment is a Flappy Bird style single-agent game using the compatibility wrapper. The first native multi-agent environment is Hearts, a four-slot turn-based trick-taking card game implemented directly against PettingZoo. Spades follows it: a four-slot partnership trick-taking game where the seats across the table are partners and share a team score, and the first environment to enable agent messaging. All three share one registry and session loop, so the same machinery runs a single paced slot and four sequential turn-based slots, including a human slot seated among agents.
