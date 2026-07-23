# Stage 2: The Real Template and Examples

Part of [Stage 2](../stage-02-harness-and-first-environment.md). This file replaces the Stage 1 placeholder under `templates/` with the real student starter kit from [submission.md](../../docs/specs/submission.md) and cuts `template-v1`. The composition and publishing machinery is already built and proven ([stage-01/examples-and-template-publishing.md](../stage-01/examples-and-template-publishing.md)); Stage 2 fills it with real content.

The starter kit is organised as two layers so the repo can carry many environments without forking the whole kit: an env-agnostic `templates/base/` and a colocated `environments/<env>/template/` layer per environment, composed by `scripts/compose.py`. The operator-facing rationale lives in [template.md](../../docs/contributors/template.md). Stage 2 ships `base/` and the first env layer, `environments/flappy_bird/template/`.

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
environments/flappy_bird/
  template/                 the first hand-authored environment layer
    README.md               the real student-facing walkthrough
    agent.py                interface stubs: reset/act raising NotImplementedError,
                            learn and chat present as commented-out examples
    sandbox/features.py     student-facing Flappy Bird helper
    tests/                  template pin tests
  examples/
    hello/                  the worked heuristic agent, a diff against the composed template
```

`agent.py` stubs the full interface without importing anything of ours. `reset` and `act` raise `NotImplementedError`, and `learn`/`chat` appear as commented-out method bodies rather than live no-ops, so the harness's presence detection sees exactly what the student enabled (see [agent-interface-and-manifest.md](agent-interface-and-manifest.md)). It lives in the env layer because its docstrings are environment-specific: the 12-feature observation and the flap action.

The dependency set is **global**: one `requirements.in`/`requirements.txt` in `base/`, the union of what every environment needs, versioned by the single `template-v<N>` axis. Env layers carry no requirements files, and compose rejects an env layer that does.

## The composed environment code

Students run Flappy Bird locally through the browser protocol and the copied `sandbox.harness` package. `scripts/generate.py` discovers environment packages under `environments/`, excluding patterns in `environments/.envignore`. `scripts/compose.py` uses the same discovered `TemplateEnvironmentSpec` facts to write each package's import-self-contained direct modules and generated exports under `build/templates/<env>/sandbox/env/`, then writes the shared harness and card helpers into that build output. Publication builds the local browser bundle once and injects it into every staged template and example. Generated-code freshness checks schema, registry, and packaging output only, while compose and example tests cover the generated student-kit files.

## Scripts

`play.py` is the environment-agnostic local browser entry point. It loads the student's agent through `manifest.json`, builds the environment from `sandbox.env`, constructs the complete live configuration, and starts the loopback relay and browser page. It shares the production live runner, browser protocol, recording path, and renderer with a session. `evaluate.py` runs N seeded episodes through the bundled harness and prints per-seed and mean scores: the same controlled-repetition shape the leaderboard uses, so local numbers predict board numbers. Neither script needs the backend, containers, or external network access.

`llm_example.py` loads `.env` with `python-dotenv`, constructs the stock `openai` client from `OPENAI_BASE_URL` and `OPENAI_API_KEY`, makes one chat-completion call, and prints the reply. The README tells participants to put the class-provided key in `.env` locally. It also explains that server-side the same two variables are injected per slot ([llm.md](../../docs/specs/llm.md)), so the code never changes between laptop and container.

## Dependency set v1

`templates/base/requirements.in` lists the top-level intents: `pettingzoo`, `gymnasium`, `numpy`, `jsonschema`, `websockets`, `python-dotenv`, and `openai`. `requirements.txt` is compiled from it with `uv pip compile`, so the full transitive closure is pinned with hashes-free exact versions. That pinned closure is the dependency set, version 1, that manifests reference and the Stage 3 base image installs. It is the single global set every environment layer shares. The compile command and the rule "edit `requirements.in`, recompile, never hand-edit `requirements.txt`" go in the template README and the contributor docs.

## Tests and the hello example

The inherited `base/tests/` check what every student repo should satisfy:

- the manifest parses and names a loadable class;
- the agent instantiates and structurally has `reset` and `act`;
- a three-step headless episode runs through `play.py`'s loop without error against the synced environment.

They run in seconds, because every composed example runs them on every PR. Because the bare template's `act` raises `NotImplementedError`, a composed example is the only green proof per env, so CI requires every env layer to ship at least one example.

`environments/flappy_bird/examples/hello/` becomes a real scripted Flappy Bird agent: a heuristic that flaps when the bird is below the next gap's center, implemented in `agent.py` over the 12-feature observation, with a test asserting it clearly outperforms noop over a few fixed seeds. It keeps its `requirements.extra.txt` (`wcwidth`, used trivially in a display string) so the extra-pin merge path stays exercised end to end in CI, not only in the compose unit tests. This same heuristic agent, loaded from the composed example's manifest, is what the stage's exit criterion runs through the harness CLI.

## Cutting template-v1

When everything above is green, run the existing `template-publish` workflow with version input 1. It performs the full Stage 1 pipeline with no new machinery:

- verifies;
- publishes the default environment's composed template (`flappy_bird`) to `vox-deorum/game-agent-template` main with the mirrored `v1` tag;
- force-pushes each environment's composed template to its `templates/<env>` branch and each composed example to its `examples/<env>/<name>` branch;
- stamps `template-v1` on the monorepo.

The student repository's placeholder warning disappears with the content it warned about.
