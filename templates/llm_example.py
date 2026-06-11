"""Minimal example of calling the provided OpenAI-compatible LLM API.

Your agent may call an LLM through a standard OpenAI-compatible endpoint. The endpoint and key
come from two environment variables, ``OPENAI_BASE_URL`` and ``OPENAI_API_KEY``:

- Locally, put the key your instructor provides in a ``.env`` file (copy ``.env.example``).
- Server-side, the harness injects the same two variables per slot with a one-off key scoped
  to your session — so this code is identical on your laptop and in the container.

    python llm_example.py
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv
from openai import OpenAI


def main() -> int:
    load_dotenv()  # read OPENAI_BASE_URL / OPENAI_API_KEY from a local .env, if present

    base_url = os.environ.get("OPENAI_BASE_URL")
    api_key = os.environ.get("OPENAI_API_KEY")
    if not base_url or not api_key:
        print(
            "Set OPENAI_BASE_URL and OPENAI_API_KEY (copy .env.example to .env and fill it in).",
            file=sys.stderr,
        )
        return 1

    client = OpenAI(base_url=base_url, api_key=api_key)
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "In one sentence, what is Flappy Bird?"}],
    )
    print(response.choices[0].message.content)
    return 0


if __name__ == "__main__":
    sys.exit(main())
