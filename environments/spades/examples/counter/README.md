# Example: spades/counter

A Spades agent that bids honestly and plays to make its contract. This directory stores its differences from the composed template:

- `agent.py` counts likely tricks, wins cheaply until the contract is safe, then avoids bags.
- `tests/test_counter.py` checks the bidding heuristic.

Compose the runnable repository:

```console
uv run python scripts/compose.py spades counter
```

The result is written to `build/examples/spades/counter/`.
