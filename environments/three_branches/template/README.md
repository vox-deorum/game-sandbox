# Days at Three Branches agent

Edit `agent.py` to write one villager's behavior. The platform runs a separate `Agent` instance for every NPC, so instances cannot share variables or memory. The supplied `sandbox/` directory contains the local runner and observation types. Leave it unchanged.

Start with the [Getting Started guide]({{DOCS_URL}}students/getting-started/), then run these commands from this folder:

```console
python -m sandbox watch
python -m sandbox test
python -m sandbox eval
```

The starter keeps its character still. Its `act` method receives a plain observation and returns a dictionary with a heading, a speed from `0.0` to `1.0`, and an action number. Read [`environment.md`](environment.md) before changing it. That guide explains the observation, movement, perception, props, speech, and local commands.

## Optional LLM API

If your instructor enables model calls, follow [Using the LLM API](llm.md). Copy `.env.example` to `.env`, add the endpoint and key, and never commit either secret.

Test the connection with:

```console
python -m sandbox llm
```

When you are ready to submit, follow the [submitting guide]({{DOCS_URL}}students/submitting/).
