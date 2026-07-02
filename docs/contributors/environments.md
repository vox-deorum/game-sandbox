# Adding an Environment

Every environment exposes the [PettingZoo AEC API](https://pettingzoo.farama.org/api/aec/) and registers one `ENTRY` through a Python entry point. Single-agent Gymnasium games use the shared adapter.

Read the [environment specification](../specs/environment.md) for product rules and [Rendering](rendering.md) for browser visuals.

## Checklist

1. Add the environment package and factory.
2. Define a legal default action.
3. Extract a JSON-compatible renderer overlay.
4. Create metadata and `ENTRY`.
5. Register the Python entry point.
6. Pass PettingZoo `api_test` and determinism tests.
7. Sync the self-contained environment code to the student template.
8. Add a template layer and at least one example.
9. Add a student helper module and its pin test when raw observations or actions need decoding.
10. Write the student environment page and add a row to the environments index.
11. Add and register a frontend renderer.

Items 9 and 10 are the [student-facing deliverables](#student-facing-deliverables): a new environment is not done when it merely runs, but when a student can find out how to play it without reading the environment source.

## Play test

`npm run play -- <env> [mode]` opens any registered environment in a window and runs it locally, with no backend, Docker, or session — the maintainer counterpart to a student's local play. `mode` is `human` (default; you play — keyboard for realtime games like Flappy Bird, click-a-card for Hearts), `agent` (watch the bundled example agent), or `watch` (the built-in baseline). Every mode begins paused on the first frame until you press a key or click, so a realtime game doesn't start before you're ready. Pass `--seat` to pick a seat in a multi-slot game, or `--agent-repo <path>` to play a `manifest.json` agent repo of your own. It resolves the environment through the same entry-point registry the harness uses, so it works for every installed environment.

## Directory layout

Each environment is its own top-level package directly under `environments/src/`, importable by its env id (`flappy_bird`) and exporting a module-level `ENTRY`:

```text
environments/src/
  flappy_bird/
    __init__.py            # ENTRY: metadata + factory + hooks (imports the harness)
    env.py                 # the make_env() factory
    overlay.py             # render-data extraction
    single_agent.py        # the Gymnasium -> AEC adapter (single-agent envs only)
```

Discovery is automatic after registration.

## Single-agent games: the adapter

A natively single-agent `gymnasium.Env` is lifted into a one-slot AEC environment by `GymnasiumToAEC`, which lives in a `single_agent.py` module inside each single-agent env package (a sibling of `env.py`, imported with `from .single_agent import GymnasiumToAEC`). It forwards the seed to the underlying env on reset (the seeding contract every environment must honor) and delegates stepping, observation, and termination bookkeeping. The single slot id is `player_0`: slot ids are PettingZoo agent ids verbatim, in state objects, metadata, and the harness API alike. Your factory just wraps your `gymnasium.make(...)` in this adapter — copy the stable `single_agent.py` into your env package. Multi-agent games subclass `pettingzoo.AECEnv` directly and skip the adapter.

## The factory and the default action

`env.py` exposes `make_env()`, a zero-argument factory that returns a fresh AEC env; the seed arrives at `reset`, not here. It also defines the environment's **default action**: the legal move the loop applies on every timeout path (noop for Flappy Bird, but a real game might return the lowest legal card). Keep `env.py` import-self-contained (intra-package relative and third-party imports only): the generate script copies it verbatim into the student template's `sandbox/env/<env>/`, so it must not import the harness.

## The overlay

The renderer never sees pixels, so the per-step `overlay` must contain everything the frontend needs to draw the frame. `overlay.py` exposes `extract_overlay(env)`, which returns JSON-compatible, unnormalized display data. For Flappy Bird, this includes the bird's position, velocity, and rotation, along with pipe coordinates, score, and screen dimensions.

Only the environment wrapper may reach into a pinned third-party package's internals. A test must confirm that every overlay field exists and is finite, so an incompatible upstream change fails before it reaches the renderer.

## The registry entry

`__init__.py` ties it together with two frozen dataclasses from `game_sandbox_harness.environment`:

- **`EnvironmentMeta`**: pure, serialisable, public-facing data the backend serves to the frontend. Its `to_json()` output must round-trip through `json.dumps`.
- **`EnvironmentEntry`**: `meta` plus the non-serialisable hooks: `make`, `default_action`, and the optional `overlay`.

This is the only environment module that imports the harness, which is why it is **not** synced into the student template.

### Metadata fields

| Field | Meaning |
| --- | --- |
| `env_id` | Stable id; matches the entry-point name. |
| `display_name`, `description` | Shown on the website. |
| `min_slots`, `max_slots` | Slot-count range. |
| `human_slots` | Tuple of slot ids a human may control. |
| `human_timeout_ms` | Human move clock; `None` when a pace interval governs the deadline. |
| `recommended_episode_ticks` | Suggested episode length. |
| `pace_interval_ms` | Set for realtime (the wall-clock cadence); `None` for turn-based. |
| `view_interval_ms` | Optional watch/replay playback cadence (ms), independent of `pace_interval_ms` so a turn-based game can slow its playback without becoming realtime. `None` falls back to the frontend's default viewing cadence; it never affects live human stepping or scoring. |
| `live_interval_ms` | Optional cadence (ms) at which a live human turn-based session plays out the _other_ seats' moves, so a burst of fast AI replies animates one card at a time instead of snapping together (the human's own move still renders on arrival). `None` — the default, and what a realtime env keeps — renders every frame on arrival. Distinct from `view_interval_ms` (spectator/replay pace, typically slower); it never affects scoring. |
| `step_limit_ms`, `episode_limit_ms` | Default agent time limits (overridable per run). |
| `messaging`, `message_cap` | Whether agents may message, and the length cap. |
| `llm` | Whether the LLM API is available to agents here. |
| `seat_order_matters` | Whether swapping agents between seats makes a distinct game for scheduler rotation. |
| `renderer` | The id the frontend resolves to a renderer module. |

The single session loop reads `pace_interval_ms` rather than branching on an environment type: realtime vs turn-based is this one field, not a second code path.

## Registration

Register the entry in `environments/pyproject.toml` under the `game_sandbox.environments` group, name = env id:

```toml
[project.entry-points."game_sandbox.environments"]
flappy_bird = "flappy_bird:ENTRY"
```

Also add the env's package to the wheel build in `environments/pyproject.toml` (`[tool.hatch.build.targets.wheel] packages = ["src/flappy_bird", ...]`). The harness enumerates installed environments through `importlib.metadata` and never imports them by name, keeping the dependency arrow pointing one way (environments → harness).

## PettingZoo conformance

Every environment must pass PettingZoo's own conformance check, so correctness is verified by the framework rather than our assumptions:

```python
from pettingzoo.test import api_test
api_test(make_env(), num_cycles=100)
```

Pair it with an environment-level determinism test (two resets with the same seed produce identical observation and overlay sequences) and the overlay-field test described above.

## Syncing to the template

Students run the environment locally without the harness. `scripts/generate.py` copies the self-contained modules into `templates/<env>/sandbox/env/`.

Register the environment and module list in `scripts/_paths.py` under `TEMPLATE_ENVS`, add the generated `__init__` text in `scripts/generate.py`, then regenerate:

```console
uv run python scripts/generate.py
```

The template's top-level `sandbox.env` package exposes `make_env`, `ENV_ID`, `PLAYER_SLOT`, and `make_human_controller`. To make the game human-playable locally, add a `human.py` exposing `make_human_controller(env)` (keyboard for realtime games, mouse/click for turn-based ones) and include it in the env's `TEMPLATE_ENVS` entry so it syncs too. Never sync harness, recording, or metadata modules. See [Examples and the template](examples-and-template.md).

## Student-facing deliverables

A student should be able to write an agent for a new environment from the docs and the template alone, without reading the environment source. That takes three things beyond a working environment: a helper module in the template, a student documentation page, and the template files that point a student at both. Follow the shape of the existing Hearts and Flappy Bird deliverables when adding your own.

### The helper module

Give the template a small helper module whenever the raw observation or action needs decoding, which is almost always: a card encoding, a set of named observation indices, an action mask. Hearts ships `sandbox/cards.py` (decode the card integer, read the observation dict) and Flappy Bird ships `sandbox/features.py` (name the twelve observation indices and the two actions). The module is student-facing template content, so hand-author it in the environment's template layer at `templates/<env>/sandbox/<name>.py`, next to the other files a student is given.

Two placement rules matter. Keep the module plain Python with no heavy imports so that `from sandbox import <name>` at the top of `agent.py` stays cheap: the base `sandbox/__init__.py` deliberately imports nothing heavy, and an agent must be able to import the helper without pulling in pettingzoo or pygame. And never place it under `sandbox/env/`, because `scripts/generate.py` wipes and regenerates that directory on every sync, so a hand-authored file there is destroyed. Tell students to import the helper at the top of `agent.py` rather than inside a method, since a submission's module-top imports are the ones the harness isolates cleanly per slot.

Because a helper restates facts that live in the environment source (the card encoding, the observation layout), add a pin test under `templates/<env>/tests/test_<name>.py` that asserts the helper agrees with the synced environment code, so the two cannot drift. The Hearts `test_cards.py` checks every card against the synced `sandbox.env.hearts.rules`, checks the observation accessors against a freshly stepped environment, and confirms in a subprocess that importing the helper does not load pygame. Every composed example inherits these template tests, so the CI `examples` job runs them.

### The student environment page

Add `docs/students/environments/<env>.md` and a row for it in `docs/students/environments/index.md`. Follow the section order the existing pages use, so a student moving between environments finds the same structure each time:

1. Title and a one-paragraph summary, reusing the `EnvironmentMeta.description` wording.
2. The game: the rules a player needs, including any variant choices your engine makes.
3. Actions: what integer `act` returns and what every value means. Give a full table when the action space is small or enumerable (the Hearts card table, the Flappy Bird two-row table), and state the rule for when a returned action is rejected.
4. Observations: a field-by-field table with each field's shape, range, and any sentinel values, and a note that values arrive as NumPy arrays.
5. Scoring and rewards: how the game is scored and what the per-step and terminal rewards are.
6. Time limits: the step and episode budgets and the pacing from `EnvironmentMeta`, what the timeout default action does, and a link to the agent interface's time-limits section.
7. Helpers in the template: document the helper module with a short before-and-after snippet and the import-at-top rule.
8. Ideas and examples: strategy pointers and links to the worked example agents.

Links inside `docs/` are relative; links to files outside `docs/`, such as the example agents under `examples/`, use their stable GitHub URL, per the [documentation guide](../AGENTS.md). Keep those intra-docs links relative even though this page is also shipped inside the template: `scripts/compose.py` copies it in as `environment.md` and rewrites each relative doc link to an absolute docs-site URL, so the same source serves both the docs site and the template.

### The template files

The template `agent.py` and `README.md` are where a student first meets the environment, so both must point at the deliverables above. The `agent.py` module docstring states the action encoding in brief and shows the helper import (a commented import line, since the unfinished template would otherwise trip the unused-import lint). The `README.md` lists the helper module and `environment.md` in its project-files table and covers the environment-agnostic workflow (set up, write, save, submit).

Neither duplicates the observation/action reference. Instead, `scripts/compose.py` ships the student environment page inside the composed template as `environment.md`, and the `README.md`, `agent.py`, and helper module all point a student at that local file. The reference therefore lives in one source, the docs page, while a student's clone still carries a complete offline copy. See [Examples and the template](examples-and-template.md) for how compose copies the page in and rewrites its cross-doc links.

Finally, every environment layer must ship at least one worked example under `examples/<env>/<name>/`, which the CI `examples` job enforces. The example is the only green end-to-end proof of the env layer, since the bare template's own agent test is red by design. Write examples that read the observation through the helper module, so they model the style students should copy, and link to them from the environment page rather than duplicating their code into the docs.
