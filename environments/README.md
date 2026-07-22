# environments/

Environment packages for Game Sandbox. Each environment is a one-stop authoring directory under `src/` (for example, `src/flappy_bird/`, importable as `flappy_bird`) and:

- Exposes a PettingZoo AEC interface.
- Exports an `ENTRY` that the sync command registers through the `game_sandbox.environments` entry-point group.
- Defines public metadata, a factory, a legal default action, and optional renderer overlay extraction.
- Owns its dedicated Python tests under `tests/`.
- Owns its browser renderer, thumbnail, and renderer tests under `renderer/`.

Single-agent Gymnasium games use a `single_agent.py` adapter (a sibling module inside the env package) to become one-slot AEC environments.

Run `npm run sync:envs` from the repository root after adding or changing an environment. The command discovers directories under `src/`, excluding patterns in `.envignore`, and regenerates Python entry points, wheel packages, backend metadata, and student-template copies. Shared packages such as `local_play/` remain in the wheel but are excluded from environment discovery. Renderer and test directories are excluded from the wheel.

See [Adding an environment](../docs/contributors/environments.md) and the [environment specification](../docs/specs/environment.md).
