# Using the LLM API

Some assignments may involve using LLMs for game agents. To do that, you will request a development key for authenticating your agent with the course website. Each key works only for one season, and the key stops working when submissions for that season close.

## Set up development access

1. Sign in to the course website and open **My Agents** in the sidebar. In the row for your environment's current season, select **Create development key**. A dialog shows the credential once; select **Copy .env** to copy both of its lines.

2. Create a file named `.env` in the project root and paste the copied lines. The result looks like this, with your real values:

   ```dotenv
   OPENAI_BASE_URL=https://course.example/api/llm/v1
   OPENAI_API_KEY=the-returned-development-key
   ```

   The template's `.env.example` shows the same two names with placeholder values.

3. Send a test request. This command uses the default `small` tier:

   ```console
   python -m sandbox llm
   ```

   The accepted tiers are `small`, `medium`, and `large`. To test another tier, pass it as an argument, for example:

   ```console
   python -m sandbox llm medium
   ```

4. Use the same exact tier name in your agent code, such as `model="medium"`.

The test command prints the chosen tier, response, and token use when successful. It never prints the API key.

Never commit `.env` or paste a key into source code, a prompt, an issue, or a chat. The template's `.gitignore` excludes `.env`, but you should still check `git status` before every commit. If you lose a key or it might have been exposed, select **Rotate development key** in **My Agents**: it issues a new key and invalidates the old one.

## Model tiers and budget

Since LLMs are more expensive than most other techniques used in game AI, it is important to use them efficiently and cost-effectively. LLMs read and write text in **tokens**, which is a short piece of text. We measure your LLM consumption through the same unit, weighted by the size (and capability) of models:

| Tier     | Default budget price |
| -------- | -------------------- |
| `small`  | 1 per token          |
| `medium` | 2 per token          |
| `large`  | 4 per token          |

You receive two allowances for each season, each with a token budget (how much you can use LLMs) and a request-rate limit (how often you can send LLM requests).

- One is for your development of the agent. Check your usage at **My Agents**;
- The other for automated leaderboard runs. In each run, each agent-controlled player receives a temporary key and its own allowance.

### Example

The template already includes the `openai` and `python-dotenv` packages this code uses, so there is nothing to install. The following Hearts example makes one request inside `act`, accepts only a numbered legal-card choice, and otherwise returns the first legal card:

```python
import os

from dotenv import load_dotenv
from openai import OpenAI
from sandbox.cards import card_name, legal_cards, play

class Agent:
    def __init__(self) -> None:
        load_dotenv()
        self.client = OpenAI(
            base_url=os.environ["OPENAI_BASE_URL"],
            api_key=os.environ["OPENAI_API_KEY"],
            max_retries=0,
        )

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation) -> int:
        legal = legal_cards(observation)
        fallback = play(legal[0])
        choices = "\n".join(
            f"{number}: {card_name(card)}" for number, card in enumerate(legal)
        )
        prompt = f"Choose a Hearts card. Reply only with its number:\n{choices}"
        try:
            response = self.client.chat.completions.create(
                model="small",
                messages=[{"role": "user", "content": prompt}],
                stream=False,
            )
            reply = (response.choices[0].message.content or "").strip()
            choice = int(reply)
            if 0 <= choice < len(legal):
                return play(legal[choice])
        except Exception:
            pass
        return fallback
```

Streaming completions are not supported. Use a normal request with `stream=False`.

### Troubleshooting

Even if your code is correct, LLM calls may fail. Therefore, keep the fallback even after you improve the prompt or response parsing.

Only successful calls spend the budget. If the service temporarily cannot track usage, calls fail with `meter_unavailable` until it recovers. Other failures may include `budget_exceeded`, `model_not_allowed`, and request or response errors. The runner handles retries, so there is no need to do your own retry loop.

## Tracing Your LLM Usage

Your prompts and the model's replies are never public: only you and the site operators can read them.

Replays of official games show that each call happened, with its tier, token counts, and budget cost, but not the text. Development calls never appear in replays or leaderboards at all; review them from **My Agents**.

See [Agent interface](agent-interface.md#llm-calls) for where model calls fit in an agent turn and the [LLM API specification](../specs/llm.md) for the complete platform rules.
