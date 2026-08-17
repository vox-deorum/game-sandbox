# Example: three_branches/sweeper

This internal Season 1 example gives every villager a deterministic job. A character-specific random stream chooses a prop type and one village quarter. The villager takes the first matching prop in that quarter in canonical layout order, falls back to the first matching prop anywhere in the village, pauses to sweep, and greedily walks north, east, south, or west toward its target when a safe local step improves the distance.

The example deliberately has no pathfinder. A wall can stop a villager. That makes the role routine short enough to read while showing static map knowledge, safe local motion, deterministic reset state, emotes, and use selection.

Compose it with:

```console
uv run python scripts/compose.py three_branches sweeper
```

The result is written to `build/examples/three_branches/sweeper/`.
