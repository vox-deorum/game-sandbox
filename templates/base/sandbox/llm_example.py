"""Minimal example of calling the provided OpenAI-compatible LLM API.

Your agent may call an LLM through a standard OpenAI-compatible endpoint. The endpoint and key
come from environment variables ``OPENAI_BASE_URL``, ``OPENAI_API_KEY``, and ``OPENAI_MODEL``:

- Locally, put the key your instructor provides in a ``.env`` file (copy ``.env.example``).
- Server-side, the harness injects the same two variables per slot with a one-off key scoped
  to your session. ``OPENAI_MODEL`` names a model alias allowed by your season.

    python -m sandbox llm
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv
from openai import OpenAI


def main() -> int:
    load_dotenv()  # read the local development settings from .env, if present

    base_url = os.environ.get("OPENAI_BASE_URL")
    api_key = os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("OPENAI_MODEL")
    if not base_url or not api_key or not model:
        print(
            "Set OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL "
            "(copy .env.example to .env and fill it in).",
            file=sys.stderr,
        )
        return 1

    # The class proxy owns retries. Disabling SDK retries keeps this smoke command to one logical
    # request and exposes the backend's terminal response directly.
    client = OpenAI(base_url=base_url, api_key=api_key, max_retries=0)
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Reply with exactly: Game Sandbox LLM ready"}],
        stream=False,
    )
    content = response.choices[0].message.content or "(empty response)"
    print(content)
    print(f"model alias: {model}")
    print(f"tokens used: {response.usage.total_tokens if response.usage is not None else 'unavailable'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
