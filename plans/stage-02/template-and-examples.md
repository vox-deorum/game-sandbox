# Stage 2: The Real Template and Examples

Part of [Stage 2](../stage-02-harness-and-first-environment.md). This file replaces the Stage 1 placeholder under `templates/` with the real student starter kit from [submission.md](../../specs/submission.md) and cuts `template-v1`. The composition and publishing machinery is already built and proven ([stage-01/examples-and-template-publishing.md](../stage-01/examples-and-template-publishing.md)); Stage 2 only changes content.

## Template inventory

```
templates/
  README.md                 the real student-facing walkthrough
  manifest.json             filled in: entry_point "agent", class_name "Agent",
                            template_version 1
  agent.py                  interface stubs: reset/act raising NotImplementedError,
                            learn and chat present as commented-out examples
  sandbox_env/              synced copy of the compatibility wrapper and the
                            Flappy Bird environment (see below)
  play.py                   local play script
  evaluate.py               simple evaluation harness
  llm_example.py            minimal LLM call via OPENAI_BASE_URL / OPENAI_API_KEY
  .env.example              the two variables, with placeholders
  requirements.in           top-level dependency intents (source of truth)
  requirements.txt          the fully pinned dependency set, compiled
  requirements-dev.txt      pytest
  conftest.py               keeps the repo root importable under pytest
  tests/                    inherited by every composed example
```

`agent.py` stubs the full interface without importing anything of ours: `reset` and `act` raise `NotImplementedError`, and `learn`/`chat` appear as commented-out method bodies rather than live no-ops, so the harness's presence detection sees exactly what the student enabled (see [agent-interface-and-manifest.md](agent-interface-and-manifest.md)).

## The synced environment code

Students run Flappy Bird locally against vanilla PettingZoo, but the environments package is never published to PyPI, so the template must carry the wrapper code itself. Hand-copying would rot. Instead, `scripts/generate.py` gains a step that copies `single_agent.py` and the `flappy_bird/` modules from `environments/src/game_sandbox_environments/` into `templates/sandbox_env/` (adjusting imports to be self-contained), and the existing staleness job diffs the result like every other generated location. The template copy is provably current on every PR, by the same mechanism that keeps schema copies current. Only the environment modules are synced; the session harness, recording store, and metadata layer stay out of the template — students need a steppable PettingZoo env, not our infrastructure.

## Scripts

`play.py` is the vanilla-PettingZoo loop the spec promises: load the student's agent through `manifest.json` (a ~20-line local loader inside the script, mirroring the harness loader's behavior), build the Flappy Bird env from `sandbox_env`, `reset(seed)`, step until termination, render with pygame unless `--headless`, print the score. `evaluate.py` runs N seeded episodes headlessly and prints per-seed and mean scores — the same controlled-repetition shape the leaderboard uses, so local numbers predict board numbers. Neither script touches the backend, the recording store, or the harness package; that is the whole point of the template per [submission.md](../../specs/submission.md).

`llm_example.py` loads `.env` with `python-dotenv`, constructs the stock `openai` client from `OPENAI_BASE_URL` and `OPENAI_API_KEY`, makes one chat-completion call, and prints the reply. The README tells participants to put the class-provided key in `.env` locally and explains that server-side the same two variables are injected per slot ([llm.md](../../specs/llm.md)), so the code never changes between laptop and container.

## Dependency set v1

`requirements.in` lists the top-level intents: `pettingzoo`, `gymnasium`, `flappy-bird-gymnasium`, `numpy`, `pygame`, `python-dotenv`, `openai`. `requirements.txt` is compiled from it with `uv pip compile` so the full transitive closure is pinned with hashes-free exact versions — that pinned closure is the dependency set, version 1, that manifests reference and the Stage 3 base image installs. The placeholder's `attrs` pin is dropped; it existed only to prove the machinery. Exact versions are resolved when the stage starts, against Python 3.12 wheels; the compile command and the rule "edit `requirements.in`, recompile, never hand-edit `requirements.txt`" go in the template README and the contributor docs.

## Tests and the hello example

The inherited `tests/` check what every student repo should satisfy: the manifest parses and names a loadable class, the agent instantiates and structurally has `reset` and `act`, and a three-step headless episode runs through `play.py`'s loop without error against the synced environment. They run in seconds, because every composed example runs them on every PR.

`examples/hello/` becomes a real scripted Flappy Bird agent: a heuristic that flaps when the bird is below the next gap's center, implemented in `agent.py` over the 12-feature observation, with a test asserting it clearly outperforms noop over a few fixed seeds. It keeps its `requirements.extra.txt` (`wcwidth`, used trivially in a display string) so the extra-pin merge path stays exercised end to end in CI, not only in the compose unit tests. This same heuristic agent, loaded from the composed example's manifest, is what the stage's exit criterion runs through the harness CLI.

## Cutting template-v1

When everything above is green, run the existing `template-publish` workflow with version input 1. It verifies, publishes the template to `vox-deorum/game-agent-template` main with the mirrored `v1` tag, force-pushes the composed `examples/hello` branch, and stamps `template-v1` on the monorepo — no new machinery, the Stage 1 pipeline as built. The student repository's placeholder warning disappears with the content it warned about.
