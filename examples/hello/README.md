# Example: hello

The smallest possible example overlay. It exists to prove the example machinery:

- It overrides one template file (`agent.py`).
- It adds one extra pinned dependency (`requirements.extra.txt`), which compose appends to the template's `requirements.txt`.
- It adds one test (`tests/test_hello.py`) on top of the inherited template tests.

An example holds only its diff against `templates/`. Run `uv run python scripts/compose_example.py hello` to materialize the full runnable agent under `build/examples/hello/`.
