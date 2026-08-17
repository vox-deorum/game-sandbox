# Example: hearts/moonshot

An aggressive Hearts agent that tries to shoot the moon. This directory stores its differences from the composed template:

- `agent.py` leads high, wins when it can, and retains point cards when void.
- `tests/test_moonshot.py` checks the winning policy.

Compose the runnable repository:

```console
uv run python scripts/compose.py hearts moonshot
```

The result is written to `build/examples/hearts/moonshot/`.
