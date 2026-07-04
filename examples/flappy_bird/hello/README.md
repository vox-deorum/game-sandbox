# Example: flappy_bird/hello

A Flappy Bird agent that builds past the environment page's first improvement and beats the environment's built-in **Naive agent**. The directory stores only its differences from the composed template:

- It overrides one template file (`agent.py`): it starts from the environment page's first improvement (flap when the bird is below the next gap's center) and adds a velocity lookahead, aiming at where the bird will be next step, which clearly outperforms doing nothing.
- It adds one extra pinned dependency (`requirements.extra.txt`, `wcwidth`), which compose appends to the template's `requirements.txt`, keeping the dependency-extension path exercised end to end.
- It adds one test (`tests/test_hello.py`) on top of the inherited template tests, asserting the heuristic beats noop and that the extra dependency composed in.

Compose the runnable repository:

```console
uv run python scripts/compose.py flappy_bird hello
```

The result is written to `build/examples/flappy_bird/hello/` and is also copied into the session base image as the built-in agent.
