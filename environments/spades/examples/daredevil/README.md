# Example: spades/daredevil

A Spades agent that bids nil, broadcasts the decision, and covers a partner who does the same. This directory stores its differences from the composed template:

- `agent.py` evaluates a nil bid, broadcasts `nil! cover me`, and covers a partner's nil.
- `tests/test_daredevil.py` checks bids, messages, and the cover response.

Compose the runnable repository:

```console
uv run python scripts/compose.py spades daredevil
```

The result is written to `build/examples/spades/daredevil/`.
