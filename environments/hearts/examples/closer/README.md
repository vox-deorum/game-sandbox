# Example: hearts/closer

A Hearts agent that focuses on playing last in a trick. This directory stores its differences from the composed template:

- `agent.py` ducks when possible and makes forced wins cheaply when points are present.
- `tests/test_closer.py` checks the last-player policy.

Compose the runnable repository:

```console
uv run python scripts/compose.py hearts closer
```

The result is written to `build/examples/hearts/closer/`.
