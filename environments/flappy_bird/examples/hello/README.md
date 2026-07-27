# Example: flappy_bird/hello

A Flappy Bird agent that aims at the next pipe gap using velocity lookahead. This directory stores only these differences from the composed template:

- `agent.py` adds the lookahead policy.
- `requirements.extra.txt` adds `wcwidth`.
- `tests/test_hello.py` checks the policy and dependency.

Compose the runnable repository:

```console
uv run python scripts/compose.py flappy_bird hello
```

The result is written to `build/examples/flappy_bird/hello/`.
