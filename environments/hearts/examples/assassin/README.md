# Example: hearts/assassin

A Hearts agent that focuses on the queen of spades. This directory stores only these differences from the composed template:

- `agent.py` leads low spades, sheds high spades when safe, and discards dangerous cards when void.
- `tests/test_assassin.py` checks a complete game and the opening policy.

Compose the runnable repository:

```console
uv run python scripts/compose.py hearts assassin
```

The result is written to `build/examples/hearts/assassin/`.
