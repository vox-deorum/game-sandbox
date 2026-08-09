# Days at Three Branches agent

Edit `agent.py` to give each villager a behavior. Every character on the cast runs its own `Agent` instance, so agents do not share Python variables or memory.

An agent receives one observation dictionary and returns one action dictionary for each village tick. The starter preserves the character's heading, stays still, and chooses no expression. It runs before you make any changes.

## Start here

1. Read [`environment.md`](environment.md) for the observation and action reference.
2. Open `agent.py` and change one part of the stand-still policy.
3. Run `python -m sandbox play` to watch a local day.
4. Run `python -m sandbox test` before submitting.

`reset(seed, observation)` runs once at the start of a day. Put setup work there. `act(observation)` runs once per tick and must return an action with `heading`, `speed`, and `action` keys.

The `sandbox/` directory and pinned requirements are provided by Game Sandbox. Do not edit them. The shared [getting started guide]({{DOCS_URL}}students/getting-started/) explains local setup and submitting a GitHub repository.

## Optional LLM API

If your instructor enables model calls, follow [Using the LLM API](llm.md). Copy `.env.example` to `.env`, add the endpoint and key, and never commit either secret.

Test the connection with `python -m sandbox llm`.
