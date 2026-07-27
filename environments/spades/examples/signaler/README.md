# Example: spades/signaler

A Spades agent that sends a partner its strongest side suit and uses the received signal when leading. This directory stores only these differences from the composed template:

- `agent.py` sends `strong:<suit>` to its partner and leads that suit when appropriate.
- `tests/test_signaler.py` checks the signal and changed lead.

Compose the runnable repository:

```console
uv run python scripts/compose.py spades signaler
```

The result is written to `build/examples/spades/signaler/`.
