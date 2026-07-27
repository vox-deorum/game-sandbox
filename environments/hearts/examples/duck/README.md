# Example: hearts/duck

A points-avoiding Hearts agent and the environment's built-in **baseline** (lowest-legal-card) opponent. The directory stores only its differences from the composed template:

- It overrides one template file (`agent.py`) with a heuristic agent that ducks under tricks and, when void, dumps its most dangerous card (the queen of spades or a high heart) instead of clinging to it. This clearly outperforms the lowest-legal-card baseline.
- It adds one extra pinned dependency (`requirements.extra.txt`, `wcwidth`), which compose appends to the template's `requirements.txt`, keeping the dependency-extension path exercised end to end.
- It adds tests (`tests/test_duck.py`) on top of the inherited template tests, asserting the agent plays a full game to completion against the built-in opponents, takes fewer points than the baseline across seeds, and that the extra dependency composed in.

Compose the runnable repository:

```console
uv run python scripts/compose.py hearts duck
```

The result is written to `build/examples/hearts/duck/` and is also copied into the session base image as a built-in agent.
