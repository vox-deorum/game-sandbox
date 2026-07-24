# environments/

Environment packages for Game Sandbox. Each environment is a one-stop authoring directory at this package root (for example, `flappy_bird/`, importable as `flappy_bird`) and:

- Exposes a PettingZoo AEC interface.
- Exports an `ENTRY` that the sync command registers through the `game_sandbox.environments` entry-point group.
- Defines public metadata, a factory, a legal default action, and optional renderer overlay extraction.
- Owns its dedicated Python tests under `tests/`.
- Owns its browser renderer, thumbnail, and renderer tests under `renderer/`.
- Owns its hand-authored student template layer under `template/`.
- Owns its worked example agents under `examples/<name>/`.
- Owns its canonical student guide at `environment.md`.

Single-agent Gymnasium games use a `single_agent.py` adapter (a sibling module inside the env package) to become one-slot AEC environments.

Run `npm run sync:envs` from the repository root after adding or changing an environment. The command discovers package directories here, excluding patterns in `.envignore`, and regenerates Python entry points, wheel packages, and backend metadata. MkDocs and the in-app documentation API discover canonical `environment.md` guides directly and expose them at virtual `students/environments/<slug>.md` paths. Shared packages such as `local_play/` remain in the wheel but are excluded from environment discovery. Canonical guides, renderer, test, template, and example directories are excluded from the wheel.

Run `uv run python scripts/compose.py <env>` to generate the complete student kit, including the environment package, harness, and shared helpers, under `build/templates/<env>/`.

See [Adding an environment](../docs/contributors/environments/index.md) and the [environment specification](../docs/specs/environment.md).
