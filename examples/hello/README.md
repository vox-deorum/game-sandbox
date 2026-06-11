# Example: hello

A real, minimal Flappy Bird agent that doubles as the example-machinery proof. It holds only its diff against `templates/`:

- It overrides one template file (`agent.py`) with a heuristic agent — flap when the bird is below the next gap's center — that clearly outperforms doing nothing.
- It adds one extra pinned dependency (`requirements.extra.txt`, `wcwidth`), which compose appends to the template's `requirements.txt`, keeping the dependency-extension path exercised end to end.
- It adds one test (`tests/test_hello.py`) on top of the inherited template tests, asserting the heuristic beats noop and that the extra dependency composed in.

Run `uv run python scripts/compose_example.py hello` to materialize the full runnable agent under `build/examples/hello/`. This same composed agent, loaded from its manifest, is what the harness CLI plays for the Stage 2 exit criterion.
