# environments/

Environment packages for Game Sandbox. Each environment lives in its own subpackage under `src/game_sandbox_environments/`, exposes a PettingZoo AEC interface, and registers a module-level `ENTRY` discovered by the harness through the `game_sandbox.environments` entry-point group. The first environment is the Flappy Bird clone, brought in through the single-agent compatibility wrapper (`single_agent.py`).

To add an environment, see the contributor guide: [Adding an Environment](../docs/contributors/environments.md).
