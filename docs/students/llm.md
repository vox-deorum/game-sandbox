# Using the LLM API

Game Sandbox can give your agent access to an OpenAI-compatible language model API. This feature is optional and must be enabled for your environment and season.

Before requesting a development key, you need an active account on the course website and the ID of an enabled season whose submission window is open. The key stops working when submissions for that season close.

You can use the same agent code on your computer and in an official session. On your computer, the code reads a season-specific development endpoint and key from `.env`. In an official session, Game Sandbox supplies a temporary endpoint and key for that player. In both cases, your code requests one model tier: `small`, `medium`, or `large`.

## Set up development access

1. Sign in to the course website and create or rotate a development key for your open season. If the website does not show a key control yet, ask your instructor for the site address and season ID. Then open the browser **developer console**, a panel that can run code on the current page. On the course website, press `F12`, `Ctrl+Shift+I`, or `Cmd+Option+I` on a Mac. Select **Console**, replace the placeholder in the snippet below with your season ID, paste it, and press Enter. MDN's [developer tools introduction](https://developer.mozilla.org/en-US/docs/Learn_web_development/Howto/Tools_and_setup/What_are_browser_developer_tools) shows how to open the console in each browser.

   ```javascript
   const seasonId = "your-season-id";
   const response = await fetch(`/api/seasons/${seasonId}/llm-development-key`, { method: "POST" });
   console.log(await response.json());
   ```

2. Copy the example environment file in the project root:

   ```console
   cp .env.example .env
   ```

   On Windows PowerShell, use `Copy-Item .env.example .env` instead. Open the new `.env` file and replace the example values with the endpoint and key returned by the website:

   ```dotenv
   OPENAI_BASE_URL=https://course.example/api/llm/v1
   OPENAI_API_KEY=the-returned-development-key
   ```

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

Your season may set different prices. The development-key response includes the enabled tiers in `models` and their applied prices in `cost_weights`.

Each participant has a separate development allowance for each season. Development calls do not use an official session's allowance. During an official session, each agent-controlled player receives a temporary key and its own allowance.

Only a call that receives a successful model response and completes accounting deducts from the persistent token budget or creates a usage record. Server retries remain part of one logical request and create at most one record. If accounting fails, the API returns `meter_unavailable` and blocks further model calls until it recovers.

In official sessions, verified time spent waiting for the model proxy during `act`, `chat`, or `learn` does not count toward the hook, step, or episode time limits. This includes retry waits. Other work inside these methods still counts. Calls made while Python imports the module, creates the agent, or runs `reset` happen before turn timing. See [Agent interface](agent-interface.md#llm-calls).

Rate limits count successful logical request starts. A request that is still running temporarily reserves capacity. A successful call records one event at its original start time, while a failed call releases its reservation. Server retries do not add events.

Your agent must always have a legal fallback action for an error it cannot recover from. Examples include `budget_exceeded`, `model_not_allowed`, a request or model error that cannot be retried, and an error that remains after the server finishes retrying. Create the standard client with `OpenAI(max_retries=0)`, as shown in the template. This leaves retries to the Game Sandbox server and keeps each turn to one logical request. Do not add another retry loop inside each turn unless your instructor designed the agent to handle the extra delay and rate-limit use.

Streaming completions are not supported. Use the standard OpenAI client's non-streaming `chat.completions.create` call with `stream=False`, as shown by the template test command.

## What is recorded and who can see it

For successful calls in an official session, public recordings may show the model tier, token counts, and budget cost. The agent owner and site operators can also inspect the accepted prompt and completion text. Other viewers cannot see that text.

Successful development calls go into a separate usage record for the season. The participant who owns the development key and site operators can inspect their prompt and completion text. Development calls never appear in session recordings, replays, or leaderboards.

See [Agent interface](agent-interface.md#llm-calls) for where model calls fit in an agent turn and the [LLM API specification](../specs/llm.md) for the complete platform rules.
