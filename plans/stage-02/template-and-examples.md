# Stage 2: The Real Template and Examples

Part of [Stage 2](../stage-02-harness-and-first-environment.md). This file replaces the Stage 1 placeholder under `templates/` with the real student starter kit from [submission.md](../../docs/specs/submission.md) and cuts `template-v1`. The composition and publishing machinery is already built and proven ([stage-01/examples-and-template-publishing.md](../stage-01/examples-and-template-publishing.md)); Stage 2 fills it with real content.

`templates/` is organised as two layers so the repo can carry many environments without forking the whole kit: an env-agnostic `templates/base/` and one `templates/<env>/` layer per environment, composed by `scripts/compose.py`. The operator-facing rationale lives in [examples-and-template.md](../../docs/contributors/examples-and-template.md). Stage 2 ships `base/` and the first env layer, `flappy_bird/`.

## Template inventory

```
templates/
  base/                     env-agnostic, never published alone
    manifest.json           filled in: entry_point "agent", class_name "Agent",
                            template_version 1
    play.py                 local play script (reads sandbox_env's make_env/PLAYER_SLOT)
    evaluate.py             simple evaluation harness
    llm_example.py          minimal LLM call via OPENAI_BASE_URL / OPENAI_API_KEY
    .env.example            the two variables, with placeholders
    requirements.in         top-level dependency intents: the single global set
    requirements.txt        the fully pinned dependency set, compiled
    requirements-dev.txt    pytest
    conftest.py             keeps the repo root importable under pytest
    tests/                  inherited by every composed example
  flappy_bird/              the first environment layer
    README.md               the real student-facing walkthrough
    agent.py                interface stubs: reset/act raising NotImplementedError,
                            learn and chat present as commented-out examples
    sandbox_env/            synced copy of the compatibility wrapper and the
                            Flappy Bird environment (see below)
examples/
  flappy_bird/hello/        the worked heuristic agent, a diff against the composed template
```

`agent.py` stubs the full interface without importing anything of ours. `reset` and `act` raise `NotImplementedError`, and `learn`/`chat` appear as commented-out method bodies rather than live no-ops, so the harness's presence detection sees exactly what the student enabled (see [agent-interface-and-manifest.md](agent-interface-and-manifest.md)). It lives in the env layer because its docstrings are environment-specific: the 12-feature observation and the flap action.

The dependency set is **global**: one `requirements.in`/`requirements.txt` in `base/`, the union of what every environment needs, versioned by the single `template-v<N>` axis. Env layers carry no requirements files, and compose rejects an env layer that does.

## The synced environment code

Students run Flappy Bird locally against vanilla PettingZoo, but the environments package is never published to PyPI, so the template must carry the wrapper code itself. Hand-copying would rot. Instead, `scripts/generate.py` copies the import-self-contained modules from `environments/src/flappy_bird/` into `templates/flappy_bird/sandbox/env/flappy_bird/`, writing minimal generated `__init__` files, and the existing staleness job diffs the result like every other generated location. The generated top-level `sandbox/env/__init__.py` exposes a uniform surface (`make_env`, `ENV_ID`, `PLAYER_SLOT`, and `make_human_controller`) so the base scripts never hardcode an environment. Each environment has one `TemplateEnvironmentSpec` in the static `TEMPLATE_ENVIRONMENTS` catalog in `scripts/_paths.py`; generation and composition use that same spec rather than separate registration maps or runtime directory discovery. Only the listed environment modules are synced. The session harness, recording store, and metadata layer stay out of the template, because students need a steppable PettingZoo env, not our infrastructure.

## Scripts

`play.py` is the vanilla-PettingZoo loop the spec promises. It loads the student's agent through `manifest.json`, builds the env from `sandbox.env` (which re-exports `make_env` and `PLAYER_SLOT` for whichever environment the template targets), calls `reset(seed)`, steps until termination, renders with pygame unless `--headless`, and prints the score. Living in `base/`, it is environment-agnostic; an environment whose local loop outgrows it overrides `play.py` whole-file in its own layer. Multi-seat overrides delegate manifest loading and their standard headless episode loop to the dependency-free `sandbox.multiseat_play` base while keeping rendering and human interaction local. `evaluate.py` runs N seeded episodes headlessly and prints per-seed and mean scores: the same controlled-repetition shape the leaderboard uses, so local numbers predict board numbers. Neither script touches the backend, the recording store, or the harness package; that is the whole point of the template per [submission.md](../../docs/specs/submission.md).

`llm_example.py` loads `.env` with `python-dotenv`, constructs the stock `openai` client from `OPENAI_BASE_URL` and `OPENAI_API_KEY`, makes one chat-completion call, and prints the reply. The README tells participants to put the class-provided key in `.env` locally. It also explains that server-side the same two variables are injected per slot ([llm.md](../../docs/specs/llm.md)), so the code never changes between laptop and container.

## Dependency set v1

`templates/base/requirements.in` lists the top-level intents: `pettingzoo`, `gymnasium`, `flappy-bird-gymnasium`, `numpy`, `pygame`, `python-dotenv`, `openai`. `requirements.txt` is compiled from it with `uv pip compile`, so the full transitive closure is pinned with hashes-free exact versions. That pinned closure is the dependency set, version 1, that manifests reference and the Stage 3 base image installs. It is the single global set every environment layer shares. The placeholder's `attrs` pin is dropped, since it existed only to prove the machinery. Exact versions are resolved when the stage starts, against Python 3.12 wheels. The compile command and the rule "edit `requirements.in`, recompile, never hand-edit `requirements.txt`" go in the template README and the contributor docs.

## Tests and the hello example

The inherited `base/tests/` check what every student repo should satisfy:

- the manifest parses and names a loadable class;
- the agent instantiates and structurally has `reset` and `act`;
- a three-step headless episode runs through `play.py`'s loop without error against the synced environment.

They run in seconds, because every composed example runs them on every PR. Because the bare template's `act` raises `NotImplementedError`, a composed example is the only green proof per env, so CI requires every env layer to ship at least one example.

`examples/flappy_bird/hello/` becomes a real scripted Flappy Bird agent: a heuristic that flaps when the bird is below the next gap's center, implemented in `agent.py` over the 12-feature observation, with a test asserting it clearly outperforms noop over a few fixed seeds. It keeps its `requirements.extra.txt` (`wcwidth`, used trivially in a display string) so the extra-pin merge path stays exercised end to end in CI, not only in the compose unit tests. This same heuristic agent, loaded from the composed example's manifest, is what the stage's exit criterion runs through the harness CLI.

## Cutting template-v1

When everything above is green, run the existing `template-publish` workflow with version input 1. It performs the full Stage 1 pipeline with no new machinery:

- verifies;
- publishes the default environment's composed template (`flappy_bird`) to `vox-deorum/game-agent-template` main with the mirrored `v1` tag;
- force-pushes each environment's composed template to its `templates/<env>` branch and each composed example to its `examples/<env>/<name>` branch;
- stamps `template-v1` on the monorepo.

The student repository's placeholder warning disappears with the content it warned about.
