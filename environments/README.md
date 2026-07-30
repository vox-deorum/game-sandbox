# environments/

Environment packages for Game Sandbox. Each environment lives in a top-level directory such as `flappy_bird/`, which is importable as `flappy_bird`. It contains:

- the declared PettingZoo sequential AEC or simultaneous parallel interface, public metadata, factory, default action, and optional renderer overlay extraction
- Python tests in `tests/` and browser renderer code and tests in `renderer/`
- the student template in `template/`, worked examples in `examples/<name>/`, and the canonical student guide in `environment.md`

Single-agent Gymnasium games use a `single_agent.py` adapter (a sibling module inside the env package) to become one-player AEC environments. Every environment declares its `stepping` mode explicitly in metadata.

After changing an environment, run `npm run sync:envs` from the repository root. It discovers packages here, excluding `.envignore` patterns, and regenerates entry points, wheel packages, and backend metadata. Canonical `environment.md` guides are published at `students/environments/<slug>.md`. Shared packages such as `local_play/` remain in the wheel but are not environments. Guides, renderers, tests, templates, and examples are not included in the wheel.

Run `uv run python scripts/compose.py <env>` to generate the complete student kit, including the environment package, harness, and shared helpers, under `build/templates/<env>/`.

See [Adding an environment](../docs/contributors/environments/index.md) and the [environment specification](../docs/specs/environment.md).
