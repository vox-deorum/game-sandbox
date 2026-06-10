# Game Sandbox Agent Template (placeholder)

> **This is a placeholder template.** The real agent template, with the agent interface stubs, the manifest, the pinned dependency set, the Shimmy wrappers, a local play script, and an LLM example, arrives in [Stage 2](https://github.com/vox-deorum/game-sandbox/blob/main/plans/stage-02-harness-and-first-environment.md). It exists now only to prove the publishing machinery end to end (template tag `template-v0`).

A submitted agent repository starts from this template. For now it carries just enough to exercise composition, dependency layering, and the test pipeline.

## Layout

- `agent.py`: the trivial placeholder agent module (an example overrides this).
- `requirements.txt`: the pinned runtime dependency set.
- `requirements-dev.txt`: dependencies for running the tests.
- `tests/`: pytest suite that every composed example inherits and must pass.

## Running the tests

```
python -m venv .venv
. .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
pytest
```
