# Example: skirmish_crane/marcher

The template's bolder sibling. Where the template walks straight toward the enemy side, each unit here remembers the tile it spawned on and marches on that tile's mirror image, which the field's point symmetry places in enemy ground, so the side sweeps the field instead of crossing it. The fighting half is the template's: step at the nearest enemy in sight and name it. This directory stores only these differences from the composed template:

- `agent.py` remembers its spawn tile and marches on its mirror, then closes on the nearest visible enemy.
- `tests/test_marcher.py` checks that every order is legal against the mask it was read from, and that a match of these units against each other ends by elimination well short of the round cap.

Compose the runnable repository:

```console
uv run python scripts/compose.py skirmish_crane marcher
```

The result is written to `build/examples/skirmish_crane/marcher/`.
