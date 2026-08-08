# Example: skirmish_crane/banner

The Season 4 starting point: a library of tactical blocks, and a side that plays them. A block is one job a unit can be given, written as a plain function of the observation, the unit's own memory, and a goal position. This directory stores only these differences from the composed template:

- `blocks.py` holds ten blocks (advance, capture, charge, fall_back, flank, harass, hold_ground, kite (back away from the nearest enemy while still striking it), screen, shield_wall) and `assign`, which hands each unit one block and one goal. Every block reads the action mask and scores the tiles it could finish on, so its order is legal by construction, and none of them plans a route.
- `agent.py` runs the assigned block and falls back to advancing when the block has nothing to say.
- `tests/test_banner.py` checks each block on constructed activations, confirms every block keeps to the mask across whole matches, and beats the built-in naive agent on pinned Season 4 seeds.

`assign` is the placeholder Season 4 asks you to replace: it commits every unit to one job in round one and never reconsiders. Deciding who should do what and where, and when that should change as the battle turns, is the assignment. The blocks are yours to edit, extend, or replace with your own.

Compose the runnable repository:

```console
uv run python scripts/compose.py skirmish_crane banner
```

The result is written to `build/examples/skirmish_crane/banner/`.
