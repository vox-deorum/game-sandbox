# Example: hearts/oracle

This Hearts agent makes one non-streaming call to the class OpenAI-compatible endpoint on each turn. It sends the legal cards and current trick state, follows a valid suggested card, and otherwise plays its lowest legal card.

Compose the runnable repository:

```console
uv run python scripts/compose.py hearts oracle
```

The result is written to `build/examples/hearts/oracle/`. It uses the `small` model tier, so the target season must make `small` available. Follow [`llm.md`](llm.md) to request a development key and configure `.env`.

From the composed repository, first make the smoke call, then run one complete local oracle game:

```console
cd build/examples/hearts/oracle
python -m sandbox llm small
python -m sandbox play --headless --seed 7
```

For an official check, commit and push the composed repository without `.env`, then submit it to the same LLM-enabled season. The official session provides its own endpoint and player key.
