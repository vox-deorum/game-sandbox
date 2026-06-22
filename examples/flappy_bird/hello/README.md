# Example: flappy_bird/hello

A minimal Flappy Bird agent and the environment's built-in **Naive agent**. The directory stores only its differences from the composed template:

- It overrides one template file (`agent.py`) with a heuristic agent, flap when the bird is below the next gap's center, that clearly outperforms doing nothing.
- It adds one extra pinned dependency (`requirements.extra.txt`, `wcwidth`), which compose appends to the template's `requirements.txt`, keeping the dependency-extension path exercised end to end.
- It adds one test (`tests/test_hello.py`) on top of the inherited template tests, asserting the heuristic beats noop and that the extra dependency composed in.

Compose the runnable repository:

```console
uv run python scripts/compose.py flappy_bird hello
```

The result is written to `build/examples/flappy_bird/hello/` and is also copied into the session base image as the built-in agent.
