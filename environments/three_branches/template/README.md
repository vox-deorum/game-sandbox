# Days at Three Branches agent

Edit `agent.py` to give every one of your villagers a routine. The platform runs a separate `Agent` instance for each NPC, so instances do not share variables or memory. The supplied `sandbox/` directory contains the local runner, types, and village helpers. Leave it unchanged.

Start with the [Getting Started guide]({{DOCS_URL}}students/getting-started/). Then run these commands from this folder:

```console
python -m sandbox watch
python -m sandbox test
python -m sandbox eval
```

## Files you will use

| Path             | Purpose                                           |
| ---------------- | ------------------------------------------------- |
| `agent.py`       | Your `Agent` implementation and starter TODOs.    |
| `environment.md` | Rules, helpers, observations, and local commands. |
| `tests/`         | Checks your submission should pass.               |
| `sandbox/`       | Local game, helpers, and types. Do not edit it.   |

The starter shows `action.walk`, `action.stand`, an emote, and `use`. Read [`environment.md`](environment.md) before changing it. Begin with one behavior that you can recognize in `watch`, then make it more responsive to the people and props it sees.

Chat is optional. If you add `chat(self, inbox)` to your agent, send and receive raw message dictionaries that use canonical player IDs such as `"player_0"` and `"player_1"`. For example, return `[{"to": "player_0", "text": "Hello."}]` to send a direct message. The village helpers do not include a chat namespace. Read [`environment.md`](environment.md#chat-with-other-agents) for the inbox format, broadcasts, and delivery timing.

`naive` is the simple cast baseline. `scripted_visitor` controls the visitor in automated runs. When you are ready to submit, follow the [submitting guide]({{DOCS_URL}}students/submitting/).

## Optional LLM API

If your instructor enables model calls, follow [Using the LLM API](llm.md). Copy `.env.example` to `.env`, add the endpoint and key, and never commit either secret.

```console
python -m sandbox llm
```
