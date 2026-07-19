# Using the LLM API

Game Sandbox can give an agent access to an OpenAI-compatible language model API. Access is optional and is enabled per environment and season. You need an enabled season with an open submission window, its season ID, and an active account on the course website before you request a development key. A development key stops working when that season's submissions close.

The same agent code works in both places. Local development uses a season-scoped development key stored in `.env`. An official session injects a temporary endpoint and key for that one agent slot. Your code chooses one of the public model aliases allowed by the season.

Official sessions inject `OPENAI_BASE_URL` and `OPENAI_API_KEY`, but not your local `OPENAI_MODEL` setting. Agent code that reads `OPENAI_MODEL` must provide a source default that the target season allows. The Hearts oracle uses `os.environ.get("OPENAI_MODEL", "small")`, so its hands-on season must allow the `small` alias before the same code can make official calls.

## Request or rotate a development key

While signed in to the course website, request a key for the submission-open season your agent targets. If the website does not yet show a key control, ask your instructor for the site address and season ID, open that site in your browser, and run this in the browser's developer console:

```javascript
const seasonId = "your-season-id";
const response = await fetch(`/api/seasons/${seasonId}/llm-development-key`, { method: "POST" });
console.log(await response.json());
```

The response contains `base_url`, `api_key`, `models`, `cost_weights`, and the season's development limits for the token budget and per-minute request rate. A model's entry in `cost_weights` is its token price, which tells you how quickly that model uses the token budget. Each request rotates the key. The previous key stops working, so rotation is also how you recover after a key is exposed.

## Configure the template

Copy the example environment file from the project root:

```console
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead. Fill in the returned endpoint and key, then choose an alias from the response's `models` list:

```dotenv
OPENAI_BASE_URL=https://course.example/api/llm/v1
OPENAI_API_KEY=the-returned-development-key
OPENAI_MODEL=small
```

Test the configuration with one non-streaming request:

```console
python -m sandbox llm
```

The smoke command prints the response, the alias you requested, and successful token usage. It never prints the API key.

Never commit `.env` or paste a key into source code, a prompt, an issue, or chat. The template's `.gitignore` excludes `.env`, but still check `git status` before every commit. Rotate the key immediately after any possible exposure.

## Limits and accounting

Development allowance is separate for each participant and season. Development calls do not spend an official session's allowance. Official sessions instead receive a temporary key and an independent allowance for each agent slot.

### Model prices

The model aliases can use different amounts of your token budget. By default, every token from the `large` model counts as 4 budget tokens, `medium` counts as 2, and `small` counts as 1. Your season may use different prices. The `cost_weights` returned with a development key contains the prices that apply to that season. The [LLM API specification](../specs/llm.md#budgets-and-limits) defines the complete accounting rule.

Only calls with a successful upstream response consume the durable token budget or create telemetry. The backend may retry a temporary upstream failure with exponential waits. Those attempts remain one logical request and, if one succeeds, create one successful record. During `act`, `chat`, or `learn`, time spent waiting and retrying still counts toward the agent's step and episode limits. Model calls made during module import, construction, or `reset` are setup calls with null tick attribution and occur before turn timing, so keep setup lightweight.

The rate limit follows the same successful-only rule, measured at request starts. While a request is in flight it holds one slot of the per-minute window, so a second call can be rate-limited by a concurrent call even if that call later fails. On success the slot becomes a recorded event stamped at the request's start; on failure or exhausted retries the slot is freed and nothing is recorded, and the backend's retries within one request never add extra events. The limit therefore bounds how many requests you can start per minute that go on to succeed.

Your agent must retain a legal fallback for a terminal error. Examples include `budget_exceeded`, a non-retryable request or upstream error, and a retryable upstream failure that still fails after the backend exhausts its retries. Construct the stock client with `OpenAI(max_retries=0)`, as the template examples do, so the backend is the only retry owner and one turn makes one logical request. Do not add another retry loop inside each game turn unless your instructor has designed the agent around the extra delay and rate use.

Streaming completions are not supported. Use the stock OpenAI Python client's non-streaming `chat.completions.create` call, as shown by `sandbox/llm_example.py`.

## What is recorded and who can see it

For successful official calls, public recording views may show the model alias, token counts, and budget cost. The agent owner and operators can also inspect the accepted prompt and completion bodies. Other viewers cannot see those bodies.

Successful development calls go into a separate season ledger. The participant who owns the development key and operators can inspect their prompt and completion bodies. Development calls never enter session recordings, replays, or leaderboards.

See [Agent interface](agent-interface.md#llm-calls) for where model calls fit in an agent turn and the [LLM API specification](../specs/llm.md) for the complete platform rules.
