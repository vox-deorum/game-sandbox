# environments/

Environment packages for Game Sandbox. Each environment is its own top-level package under `src/` (e.g. `src/flappy_bird/`, importable as `flappy_bird`) and:

- Exposes a PettingZoo AEC interface.
- Registers an `ENTRY` through the `game_sandbox.environments` entry-point group.
- Defines public metadata, a factory, a legal default action, and optional renderer overlay extraction.

Single-agent Gymnasium games use a `single_agent.py` adapter (a sibling module inside the env package) to become one-slot AEC environments.

See [Adding an environment](../docs/contributors/environments.md) and the [environment specification](../docs/specs/environment.md).
