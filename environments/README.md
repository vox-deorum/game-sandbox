# environments/

Environment packages for Game Sandbox. Each environment:

- Exposes a PettingZoo AEC interface.
- Registers an `ENTRY` through the `game_sandbox.environments` entry-point group.
- Defines public metadata, a factory, a legal default action, and optional renderer overlay extraction.

Single-agent Gymnasium games use `single_agent.py` to become one-slot AEC environments.

See [Adding an environment](../docs/contributors/environments.md) and the [environment specification](../docs/specs/environment.md).
