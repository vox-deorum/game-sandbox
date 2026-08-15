# Example: hearts/duck

A points-avoiding Hearts agent designed to beat the built-in baseline. This directory stores only these differences from the composed template:

- `agent.py` ducks under tricks and discards dangerous cards when void.
- `tests/test_duck.py` checks the policy, scores, and the template-provided `wcwidth` dependency.

Compose the runnable repository:

```console
uv run python scripts/compose.py hearts duck
```

The result is written to `build/examples/hearts/duck/`.
