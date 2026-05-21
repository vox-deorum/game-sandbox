# Environments

Every environment exposes a PettingZoo interface. Games that are natively single-agent come in through a Shimmy wrapper so they fit the same shape as multi-agent games. There is one environment framework in the system, not two.

## Metadata layers

Each environment carries two layers of metadata.

**Intrinsic metadata** is already provided by PettingZoo:

- Action space.
- Observation space.
- Agent IDs.
- Default reward scheme.

**Public-facing metadata** is added by us so the website can present the environment and so the leaderboard workflow knows how to run it:

- Display name and a short description.
- Minimum and maximum number of agent slots.
- Which slots accept a human player.
- Recommended episode length.
- Default per-step and per-episode time limits. These are defaults only. Each iteration can override them (see [leaderboard.md](leaderboard.md)).
- A reference to the renderer that knows how to draw this environment. See [interaction.md](interaction.md).

Scoring weights for the automated leaderboard are not stored here. Each iteration is one competition with its own weighted score formula, so weights live on the iteration. See [leaderboard.md](leaderboard.md).

The intrinsic layer is what the environment code already gives us. The public-facing layer is what we add so the same environment can be presented on a website, plugged into the leaderboard workflow, and discovered by participants. Both layers travel together.

## First environment

The first environment is a Flappy Bird style single-agent game brought in through Shimmy. Multi-agent environments follow once the pipeline is proven on a simple case.
