# Using the LLM API

Game Sandbox can give an agent access to an OpenAI-compatible language model API. Access is optional and is enabled per environment and season. You need an enabled season with an open submission window, its season ID, and an active account on the course website before you request a development key. A development key stops working when that season's submissions close.

Use the same agent code locally and in an official session. Locally, it reads a season-scoped development endpoint and key from `.env`. An official session supplies a temporary endpoint and key for that agent slot. In both cases, agent code sends one fixed model tier: `small`, `medium`, or `large`.

## Set up development access

1. While signed in to the course website, create or rotate a development key for the open season your agent targets. If the website does not yet show a key control, ask your instructor for the site address and season ID, then run this in the browser developer console:

   ```javascript
   const seasonId = "your-season-id";
   const response = await fetch(`/api/seasons/${seasonId}/llm-development-key`, { method: "POST" });
   console.log(await response.json());
   ```

2. Copy the example environment file from the project root and put the returned endpoint and key in it:

   ```console
   cp .env.example .env
   ```

   On Windows PowerShell, use `Copy-Item .env.example .env` instead.

   ```dotenv
   OPENAI_BASE_URL=https://course.example/api/llm/v1
   OPENAI_API_KEY=the-returned-development-key
   ```

3. Send one test request. This uses the default `small` tier:

   ```console
   python -m sandbox llm
   ```

   The accepted tiers are `small`, `medium`, and `large`. To test another tier, pass it as an argument, for example:

   ```console
   python -m sandbox llm medium
   ```

4. Use the same literal tier in your agent code, for example `model="medium"`.

The smoke command prints the selected tier, response, and successful token usage. It never prints the API key.

Never commit `.env` or paste a key into source code, a prompt, an issue, or chat. The template's `.gitignore` excludes `.env`, but still check `git status` before every commit. Rotate the key immediately after any possible exposure.

## Model tiers and budget

These are the only public model choices. A season enables one or more tiers. Use a tier that the season makes available; a disabled tier returns `model_not_allowed` and is never replaced with a different tier.

| Tier     | Default budget price |
| -------- | -------------------- |
| `small`  | 1 per token          |
| `medium` | 2 per token          |
| `large`  | 4 per token          |

Your season may set different prices. The development-key response includes the enabled tiers in `models` and their applied prices in `cost_weights`.

Development allowance is separate for each participant and season. Development calls do not spend an official session's allowance. Official sessions instead receive a temporary key and an independent allowance for each agent slot.

Only a fully accounted call with a successful upstream response consumes the durable token budget and creates telemetry. The backend may retry a temporary upstream failure, but those attempts remain one logical request and create at most one successful record. An accounting failure returns `meter_unavailable` and blocks more model calls until recovery, so it cannot provide free calls. During `act`, `chat`, or `learn`, time spent waiting and retrying still counts toward the agent's step and episode limits. Calls made during module import, construction, or `reset` are setup calls with null tick attribution, so keep setup lightweight.

The rate limit follows the same successful-only rule, measured at request starts. While a request is in flight it holds one slot of the per-minute window, so a second call can be rate-limited by a concurrent call even if that call later fails. On success the slot becomes a recorded event stamped at the request's start; on failure or exhausted retries the slot is freed and nothing is recorded. The backend's retries within one request never add extra events.

Your agent must retain a legal fallback for a terminal error. Examples include `budget_exceeded`, `model_not_allowed`, a non-retryable request or upstream error, and a retryable upstream failure that still fails after the backend exhausts its retries. Construct the stock client with `OpenAI(max_retries=0)`, as the template examples do, so the backend is the only retry owner and one turn makes one logical request. Do not add another retry loop inside each game turn unless your instructor has designed the agent around the extra delay and rate use.

Streaming completions are not supported. Use the stock OpenAI client's non-streaming `chat.completions.create` call with `stream=False`, as shown by the template smoke command.

## What is recorded and who can see it

For successful official calls, public recording views may show the model tier, token counts, and budget cost. The agent owner and operators can also inspect the accepted prompt and completion bodies. Other viewers cannot see those bodies.

Successful development calls go into a separate season ledger. The participant who owns the development key and operators can inspect their prompt and completion bodies. Development calls never enter session recordings, replays, or leaderboards.

See [Agent interface](agent-interface.md#llm-calls) for where model calls fit in an agent turn and the [LLM API specification](../specs/llm.md) for the complete platform rules.
