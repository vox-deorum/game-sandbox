# Example: three_branches/sweeper

This small example replaces the template agent with one that stands still and selects the `sweep` expression on every tick. It uses the raw action dictionary, so it is a useful smoke example for the basic agent contract.

Compose the runnable repository:

```console
uv run python scripts/compose.py three_branches sweeper
```

The result is written to `build/examples/three_branches/sweeper/`.
