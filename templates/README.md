# Game Sandbox Agent Template

This is the starter kit for writing a Game Sandbox agent. You develop and test entirely on your own machine against vanilla PettingZoo — no backend, no account, no network — and submit a GitHub repository when you are ready. This template **is** the shape of a submittable repo: fill in `agent.py`, keep the manifest and the pinned dependency set, and you are done.

## Layout

| Path | What it is |
| --- | --- |
| `agent.py` | **Your agent.** Implement `reset` and `act`; optionally `learn` and `chat`. |
| `manifest.json` | Names your entry-point module, agent class, and the template version. |
| `requirements.in` | The top-level dependency intents (source of truth). |
| `requirements.txt` | The fully pinned dependency set — the authoritative list. Do not hand-edit. |
| `requirements-dev.txt` | Test-only dependencies (`pytest`). |
| `sandbox_env/` | The Flappy Bird environment, so you can step it locally. Generated; do not edit. |
| `play.py` | Play one episode, with or without a render window. |
| `evaluate.py` | Run several seeded episodes headless and print the mean score. |
| `llm_example.py` | Minimal OpenAI-compatible LLM call. |
| `.env.example` | The two LLM variables; copy to `.env` for local use. |
| `tests/` | Checks every submission should pass; run them with `pytest`. |

## Setup

```
python -m venv .venv
. .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
```

Use exactly `requirements.txt`: it is the pinned dependency set for this template version, the same set the server installs, so your local runs match the server's. If you need a library it lacks, ask the operator for a new template release rather than pinning it yourself.

## Write your agent

Edit `agent.py`. The interface is four methods, two required:

- `reset(seed)` — prepare for a new episode. The seed is the same one the environment gets.
- `act(observation)` — return an action. For Flappy Bird that is `0` (do nothing) or `1` (flap).
- `learn(observation, action, reward, terminated)` — _optional_; called after each step.
- `chat(inbox)` — _optional_; only used in environments with messaging.

The optional hooks are detected by presence: leave them out (or commented) and the harness never calls them. Time spent in any of these counts against your per-step and per-episode limits, so an agent that learns or talks heavily pays for it in the efficiency column.

## Run it

```
python play.py                 # render in a window
python play.py --headless      # no window, just the score
python evaluate.py --episodes 10
pytest                         # the submission checks
```

The Flappy Bird observation is a length-12 NumPy array of normalized features (pipe positions, the bird's height, velocity, and rotation); the action space is `Discrete(2)`.

## Using the LLM API (optional)

Copy `.env.example` to `.env` and fill in the endpoint and key your instructor provides, then:

```
python llm_example.py
```

Your code reads `OPENAI_BASE_URL` and `OPENAI_API_KEY`. Server-side the harness injects the same two variables per slot with a one-off session key, so the code never changes between your laptop and the container.

## Submitting

Push your repository to GitHub and submit its link through the course website, pinned to a commit. Submitting again while an iteration is open replaces your previous submission.

## Updating dependencies

`requirements.txt` is compiled from `requirements.in`; never hand-edit it. If a new template release changes the set, pull it and recompile:

```
uv pip compile requirements.in -o requirements.txt --python-version 3.12
```
