# Using the LLM API

Game Sandbox can give your agent access to an OpenAI-compatible language model API. This feature is optional and must be enabled for your environment and season.

Before requesting a development key, you need an active account on the course website and an enabled season whose submission window is open. The key stops working when submissions for that season close.

You can use the same agent code on your computer and in an official session. On your computer, the code reads a season-specific development endpoint and key from `.env`. In an official session, Game Sandbox supplies a temporary endpoint and key for that player. In both cases, your code requests one model tier: `small`, `medium`, or `large`.

## Set up development access

1. Sign in to the course website and open **My Agents** in the sidebar. In the row for your environment's current season, select **Create development key**. A dialog shows the credential once; select **Copy .env** to copy both of its lines. If you lose the key, **Rotate development key** issues a new one and invalidates the old one.

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

Never commit `.env` or paste a key into source code, a prompt, an issue, or a chat. The template's `.gitignore` excludes `.env`, but you should still check `git status` before every commit. If a key might have been exposed, rotate it immediately.

## Model tiers and budget

These are the only public model choices. Each season enables one or more tiers. If you request a disabled tier, the API returns `model_not_allowed`; it never substitutes another tier.

| Tier     | Default budget price |
| -------- | -------------------- |
| `small`  | 1 per token          |
| `medium` | 2 per token          |
| `large`  | 4 per token          |

Your season may set different prices. The development-key response lists its enabled tiers in `models` and their applied prices in `cost_weights`.

Each participant has a separate development allowance for each season. Development calls do not use an official session's allowance. During an official session, each agent-controlled player receives a temporary key and its own allowance. Each allowance has a token budget and request-rate limit set by the season.

The API charges the token budget only after a successful model response whose usage it can record. If usage accounting is temporarily unavailable, it returns `meter_unavailable` and rejects calls until it recovers.

Your agent must always have a legal fallback action for an error it cannot recover from. Common examples are `budget_exceeded`, `model_not_allowed`, `meter_unavailable`, and request or response errors. Create the standard client with `OpenAI(max_retries=0)`, as shown in the template. Game Sandbox handles retries, so do not add a per-turn retry loop unless your instructor designed the agent to handle the extra delay and rate-limit use.

Streaming completions are not supported. Use the standard OpenAI client's non-streaming `chat.completions.create` call with `stream=False`, as shown by the template test command.

## What is recorded and who can see it

For successful calls in an official session, public recordings may show the model tier, token counts, and budget cost. The agent owner and site operators can also inspect the accepted prompt and completion text. Other viewers cannot see that text.

Successful development calls use a separate season record. The participant who owns the development key and site operators can inspect their prompt and completion text. Development calls never appear in session recordings, replays, or leaderboards.

See [Agent interface](agent-interface.md#llm-calls) for where model calls fit in an agent turn and the [LLM API specification](../specs/llm.md) for the complete platform rules.
