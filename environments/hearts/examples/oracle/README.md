# Example: hearts/oracle

This Hearts agent makes one non-streaming call through the class OpenAI-compatible endpoint on each turn. It sends only the legal cards and current trick state, follows one legal card named by the completion, and otherwise plays its lowest legal card. The fallback covers malformed completions, exhausted budgets, non-retryable errors, and retryable failures that remain unsuccessful after the backend finishes its retries.

Compose the runnable repository:

```console
uv run python scripts/compose.py hearts oracle
```

The result is written to `build/examples/hearts/oracle/`. This example always uses the `small` model tier, so the target season must make `small` available. Follow [`llm.md`](llm.md) to request a season development key and put the returned endpoint and key in `.env`.

From the composed repository, first make the smoke call, then run one complete local oracle game:

```console
cd build/examples/hearts/oracle
python -m sandbox llm small
python -m sandbox play --headless --seed 7
```

For the official check, leave `agent.py` unchanged after the local run, commit and push the composed repository without `.env`, and submit that exact commit to the same LLM-enabled season. Start a session with the ready submission, let the game finish, and confirm its replay shows successful model-call metadata. The official session injects its own endpoint and slot key, so this check must not require an official-only code or configuration edit.
