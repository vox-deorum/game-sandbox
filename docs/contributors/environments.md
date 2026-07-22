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

`npm run play -- <env> [mode]` rebuilds the local frontend, then starts loopback browser play with the production live runner and the same PixiJS renderer used by a live session. It needs no backend, Docker, or external network connection. `mode` is `human` (default; keyboard for realtime games such as Flappy Bird, click a card for Hearts), `agent` (watch the bundled example agent), or `watch` (the built-in baseline). Every mode starts paused at the first frame. Use the page's Start control when ready, then use its shared pause, resume, and stop controls. Pass `--seat` to choose a multi-slot seat, or `--agent-repo <path>` to play an agent repository with a `manifest.json`. The command resolves the environment through the same entry-point registry and live-runner path as the harness.

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

`env.py` exposes `make_env()`, a zero-argument factory that returns a fresh AEC env; the seed arrives at `reset`, not here. It also defines the environment's **default action**, `default_action(env, slot_id)`: given the live env and a slot, it returns the real, legal integer the loop applies on a timeout — the idle action `0` for Flappy Bird, the lowest legal card for Hearts, a never-nil suggested bid or lowest legal card for Spades — so a timeout recording holds the action that was actually played rather than a sentinel. Keep `env.py` import-self-contained (intra-package relative and third-party imports only): the generate script copies it verbatim into the student template's `sandbox/env/<env>/`, so it must not import the harness.

## The overlay

The renderer never sees pixels, so the per-step `overlay` must contain everything the frontend needs to draw the frame. `overlay.py` exposes `extract_overlay(env)`, which returns JSON-compatible, unnormalized display data. For Flappy Bird, this includes the bird's position, velocity, and rotation, along with pipe coordinates, score, and screen dimensions.

The environment owns its display state. A test must confirm that every overlay field exists and is finite. Flappy Bird reads its immutable local simulation snapshot, not private fields from a third-party package.

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

An environment with an object-shaped, composite inner `observation` (the card games' `{"observation": {…}, "action_mask": …}` wrapper) trips the known [PettingZoo #1211](https://github.com/Farama-Foundation/PettingZoo/issues/1211) `api_test` bug in pinned 1.26.1, where reading a `.dtype` off the composite observation raises; the [environment spec](../specs/environment.md#pettingzoo-conformance-and-the-api_test-1211-bug) records the exact failure. Run `api_test` through the shared guard that treats exactly that failure as expected and re-raises anything else, and keep the linked TODO so the guard is deleted once a fixed PettingZoo ships. Validate the observation directly with `observation_space.contains()` across a complete episode, which the bug does not affect.

Pair this with an environment-level determinism test (two resets with the same seed produce identical observation and overlay sequences) and the overlay-field test described above.

## Syncing to the template

Students run the environment locally through the copied `sandbox.harness` package. `scripts/generate.py` copies each environment's self-contained modules into `templates/<env>/sandbox/env/` and the shared harness into the base template.

Add one `TemplateEnvironmentSpec` to the static `TEMPLATE_ENVIRONMENTS` catalog in `scripts/_paths.py`, then regenerate. The spec keeps the display name, inner package, module-copy list, default-action export, and player slot together. Generation and composition both read this catalog and do not discover environment directories at runtime, so an unregistered directory cannot silently become a student template.

```console
uv run python scripts/generate.py
```

The template's top-level `sandbox.env` package exposes the generated environment metadata and factory surface. Human input belongs in the browser renderer, not in a Python `human.py` module. Include the environment's import-self-contained modules and any credited source files in its template specification. The copied `sandbox.harness` package provides the supported local runner and relay surface. See [Examples and the template](examples-and-template.md).

## Student-facing deliverables

A student should be able to write an agent for a new environment from the docs and the template alone, without reading the environment source. That takes three things beyond a working environment: a helper module in the template, a student documentation page, and the template files that point a student at both. Follow the shape of the existing Hearts and Flappy Bird deliverables when adding your own.

### The helper module

Give the template a small helper module whenever the object-shaped observation or the integer action needs a game-specific bridge, which is almost always: a card codec, named observation fields, an action mask to read. Hearts and Spades ship `sandbox/cards.py` (read the semantic card objects and observation fields, and convert a chosen card or bid to its integer action) and Flappy Bird ships `sandbox/features.py` (name the observation fields — the bird and the pipes — and the two actions). The module is student-facing template content, so hand-author it in the environment's template layer at `templates/<env>/sandbox/<name>.py`, next to the other files a student is given.

Two placement rules matter. Keep the module plain Python with no heavy imports so that `from sandbox import <name>` at the top of `agent.py` stays cheap: the base `sandbox/__init__.py` deliberately imports nothing heavy, and an agent must be able to import the helper without pulling in PettingZoo or browser-play dependencies. Never place it under `sandbox/env/`, because `scripts/generate.py` wipes and regenerates that directory on every sync, so a hand-authored file there is destroyed. Tell students to import the helper at the top of `agent.py` rather than inside a method, since a submission's module-top imports are the ones the harness isolates cleanly per slot.

Because a helper restates facts that live in the environment source (the card encoding, the observation layout), add a pin test under `templates/<env>/tests/test_<name>.py` that asserts the helper agrees with the synced environment code, so the two cannot drift. The Hearts `test_cards.py` checks every card against the synced `sandbox.env.hearts.rules` and checks the observation accessors against a freshly stepped environment. Every composed example inherits these template tests, so the CI `examples` job runs them.

Hearts and Spades share only the game-independent semantic-card operations from the dependency-free base `sandbox.semantic_cards` module. Each environment's `sandbox.cards` imports and re-exports those established names, then keeps its own legality, scoring, bidding, partnership, and observation helpers locally. Preserve those `sandbox.cards` exports when adding common card operations so existing student agents do not need to change imports.

### The student environment page

Add `docs/students/environments/<env>.md` and a row for it in `docs/students/environments/index.md`. Follow the section order the existing pages use, so a student moving between environments finds the same structure each time:

1. Title and a one-paragraph summary, reusing the `EnvironmentMeta.description` wording.
2. How the game works: the rules a player needs, including any variant choices your engine makes.
3. Your first agent: a how-to that builds the naive agent the template ships, described in game terms with no raw encodings, introducing only the helpers it uses, ending in a code listing byte-identical to the template `agent.py` body and the `python -m sandbox play`/`eval`/`test` commands.
4. Scoring and rewards: how the game is scored and what the per-step and terminal rewards are.
5. The helper module: document the helper module, its import-at-top rule, and a full table of its helpers and constants.
6. Under the hood: the raw, helper-free reference for a reader who outgrows the helpers, holding a helper-free snippet that reads the observation fields directly and then the demoted Actions and Observations subsections. Actions gives what integer `act` returns and what every value means (a full table when the action space is small or enumerable, plus the rule for when a returned action is rejected); Observations describes the object-shaped observation field by field — each field's shape and range, the categorical code any "none yet" field uses (for example a led suit of `4`), and, for a card game, that the semantic state sits under `"observation"` beside the one array, the top-level `action_mask`.
7. Time limits: the step and episode budgets and the pacing from `EnvironmentMeta`, what the timeout default action does, and a link to the agent interface's time-limits section.
8. Your first improvement: a Socratic path from the naive starting agent to its first upgrade, written to provoke the student into discovering the upgrade rather than copying it. Open with a watching assignment (`python -m sandbox play`) that lets the student witness the starting agent's flaw before the fix has a name, then pose each hint as a question in its own paragraph, framed in game terms, with the check-yourself answer or nudge in a blockquote beneath it. The nudges stop at pointing to the helper-module table: the section never shows solution code, never names the helpers to call, and never states the decision rule. Close with the measurement loop (record the `eval` mean, change one thing, compare) and a single forward-looking question that points at the next improvement and has a shipped worked example as its unlinked answer. Do not link complete example agents from the page, and do not grow the closing question into an idea list.

Links inside `docs/` are relative; links to files outside `docs/` use their stable GitHub URL, per the [documentation guide](../AGENTS.md). Keep those intra-docs links relative even though this page is also shipped inside the template: `scripts/compose.py` copies it in as `environment.md` and rewrites each relative doc link to an absolute docs-site URL, so the same source serves both the docs site and the template.

### The template files

The template `agent.py` and `README.md` are where a student first meets the environment, so both must point at the deliverables above. The `agent.py` ships the working starting agent itself: a module docstring that names the strategy in one line and points at `environment.md`, a live helper import, and a body byte-identical to the docs page's code listing, with a `TODO(you)` comment marking where the student takes over and pointing at the "Your first improvement" section of `environment.md`. The `README.md` lists the helper module and `environment.md` in its project-files table and covers the environment-agnostic workflow (set up, improve, save, submit).

Neither duplicates the observation/action reference. Instead, `scripts/compose.py` ships the student environment page inside the composed template as `environment.md`, and the `README.md`, `agent.py`, and helper module all point a student at that local file. The reference therefore lives in one source, the docs page, while a student's clone still carries a complete offline copy. See [Examples and the template](examples-and-template.md) for how compose copies the page in and rewrites its cross-doc links.

Finally, every environment layer must ship at least one worked example under `examples/<env>/<name>/`, which the CI `examples` job enforces. The bare template is itself green now that it ships a working starting agent; an example is the proof that a worked strategy, a notch beyond the naive starting agent, builds on the env layer and composes end to end. Write examples that read the observation through the helper module, so they model the style students should copy; the environment page's "Your first improvement" section never shows or links their code, but its improvement and its closing question should each have a worked example as the answer key a teacher can reach for.
