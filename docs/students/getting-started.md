# Getting Started

You write a Game Sandbox agent in Python and test it entirely on your own machine, against vanilla PettingZoo — no account, no backend, no network. When it is ready, you submit a GitHub repository link through the course website. This page gets you from zero to a running agent.

## 1. Get the template

Start from the agent template repository your instructor points you to. It is a complete, submittable repo: you fill in one file and you are done.

```
git clone <your-copy-of-the-template>
cd <your-repo>
python -m venv .venv
. .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
```

Install exactly `requirements.txt`. It is the **pinned dependency set** for this template version — the same set the server installs — so your local runs match the server's. If you need a library it lacks, ask the operator for a new template release rather than pinning it yourself; everyone in a season runs on the same set.

## 2. Write your agent

Edit `agent.py`. The interface is small (see [Agent Interface](agent-interface.md) for the full contract):

- `reset(seed)` — prepare for a new episode.
- `act(observation)` — return an action. For Flappy Bird that is `0` (do nothing) or `1` (flap).
- `learn(...)` and `chat(...)` are optional and detected by presence — leave them out unless you implement them.

The Flappy Bird observation is a length-12 NumPy array of normalized features (the next pipe positions, the bird's height, velocity, and rotation).

## 3. Run it

```
python play.py                 # render in a window
python play.py --headless      # no window, just the score
python evaluate.py --episodes 10
```

`play.py` plays one episode through the same agent-environment cycle the server runs. `evaluate.py` runs several seeded episodes headless and prints the mean — the same controlled-repetition shape the leaderboard uses, so your local mean predicts your board number.

## 4. Run the checks

```
pytest
```

The inherited tests check what every submission should satisfy: the manifest names a loadable agent, and your agent can drive the environment. The bare template's `act` raises until you implement it — that is the signal that you have work to do.

## 5. Using the LLM API (optional)

If your environment allows it, your agent may call an OpenAI-compatible LLM. Copy `.env.example` to `.env`, fill in the endpoint and key your instructor provides, then:

```
python llm_example.py
```

Your code reads `OPENAI_BASE_URL` and `OPENAI_API_KEY`. Server-side the harness injects the same two variables per slot with a one-off session key, so the code never changes between your laptop and the container. See the [LLM spec](../specs/llm.md).

## 6. Submit

Push to GitHub and submit the repository link, pinned to a commit, through the course website. Submitting again while a season is open replaces your previous submission. The full rules are in the [submission spec](../specs/submission.md).
