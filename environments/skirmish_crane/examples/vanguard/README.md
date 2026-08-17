# Example: skirmish_crane/vanguard

A Skirmish at Crane Reach detachment that runs one small state machine per unit type and coordinates through nothing but what its units can see. This directory stores its differences from the composed template:

- `agent.py` falls back and fires with the archer, flanks with the cavalry, and holds the line with the footman, on top of four shared habits: form up around the middle of the field, never walk into a melee alone, nobody leaves the battle area to chase, and concentrate on the weakest enemy in sight.
- `tests/test_vanguard.py` checks each state machine on constructed activations, and beats the built-in naive agent on pinned seeds, from either side of a skirmish and in a Season 3 battle.

Compose the runnable repository:

```console
uv run python scripts/compose.py skirmish_crane vanguard
```

The result is written to `build/examples/skirmish_crane/vanguard/`.
