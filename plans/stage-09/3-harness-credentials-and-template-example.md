# Stage 9.3: Harness Credentials and the Student LLM Example

Status: complete.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 3.

## Outcome

The harness supplies the correct slot key whenever participant code runs and marks the tick used by each successful official call. The template and student guide use season-scoped development credentials locally and the same two OpenAI environment variables used in official sessions. Agent code always requests one literal model tier: `small`, `medium`, or `large`.

The hands-on check runs the Hearts oracle locally with a requested development key and runs the same agent in an LLM-enabled session with injected slot credentials.

## Harness configuration

`live.py::parse_config` accepts the launch block produced by Step 2:

```py
@dataclass(frozen=True)
class LlmConfig:
    base_url: str
    tick_url: str
    keys: dict[str, str]
```

`LiveConfig.llm` is `None` for a non-LLM session. Validation requires one key for every configured agent slot, rejects keys for unknown slots, and keeps the backend and Python launch-config fixtures in lockstep.

## Slot credentials

A helper owns the harness environment changes:

- Set `OPENAI_BASE_URL` from `LlmConfig.base_url` before loading participant modules.
- Set `OPENAI_API_KEY` to a slot's key immediately before importing and constructing that slot's agent.
- Set the slot key before its `reset` hook.
- Set the acting slot's key at the start of its turn, covering `act`, `chat`, and `learn`.

Agents execute sequentially in one process, so these changes give module-level clients and hook-level clients the correct grant. A session key provides attribution inside the container trust boundary; it is not an isolation boundary between agents sharing that container.

When `LiveConfig.llm` is `None`, the harness performs no credential or marker operations. Existing deterministic fixtures pin the non-LLM path.

## Tick markers and telemetry attribution

Send a `POST` request to `LlmConfig.tick_url` with the slot's bearer key at the same ownership boundaries as the credential helper. The harness uses the configured URL directly and does not derive it from the OpenAI base URL.

- `{"phase":"setup"}` before module load, construction, and reset.
- `{"tick":N}` before the acting slot's hooks for tick `N`.

Use a small synchronous standard-library HTTP helper with a bounded local timeout. A marker failure writes a concise stderr diagnostic and allows the episode to continue. The model request still follows the agent's normal error handling. Because model requests do not carry a separate tick value, the backend retains that slot's last successful marker after a marker failure. Exact tick attribution resumes with the next successful marker. This is the explicit availability exception to per-call tick attribution.

Calls made during setup carry a null tick in execution-scope SQLite. Calls made during a turn carry the marked tick. Durable scope and session IDs on recording metadata associate those rows with replays.

Time spent in the backend proxy during `act`, `chat`, or `learn`, including upstream attempts and exponential waits, remains inside the blocking participant hook. The existing wall-clock measurement therefore includes it in the corresponding decision, chat, or learn time and in step and episode limits. Module load, construction, and `reset` calls are setup work with null tick attribution and occur before turn timing.

## Template command and environment file

Update the existing `templates/base/.env.example` to contain:

```dotenv
OPENAI_BASE_URL=
OPENAI_API_KEY=
```

Students copy the `base_url` and `api_key` returned by `POST /api/seasons/:seasonId/llm-development-key`. The key response identifies enabled tiers and prices, but it does not add a model-setting environment variable.

Update the existing `templates/base/sandbox/llm_example.py` to accept an optional `small`, `medium`, or `large` argument, default to `small`, validate it before constructing a client, make one non-streaming chat-completion request with the stock Python `openai` client, and report the selected model tier and successful token usage without printing the key. Disable SDK retries so the backend remains the only retry owner and one smoke call remains one logical request. Replace its documented direct-module invocation, `python -m sandbox.llm_example`, with `python -m sandbox llm [small|medium|large]`.

Extend the existing dispatcher in `templates/base/sandbox/__main__.py` with an `llm` command that invokes `sandbox.llm_example`. Give it a dedicated dependency probe, `import openai, dotenv`, so a runtime that satisfies the game dependencies but lacks the LLM client is bootstrapped before the example runs. Change `_runtime_python` to return an existing `.venv` interpreter only when it passes the selected command's probe; otherwise `setup()` repairs that environment from the pinned requirements before dispatch. Add `llm` to the module overview, command help, dispatcher table, and command set. Update the existing template READMEs and composed outputs to show the dispatcher command instead of the direct module command.

## Hearts oracle example

Add `examples/hearts/oracle/`. On each turn it:

1. Reads semantic card data through the template's cards helper.
2. Sends a compact prompt listing the legal cards and relevant trick state.
3. Parses one legal-card choice from the completion.
4. Uses the lowest legal card when the API returns a terminal error, the completion is malformed, or the selected card is illegal.

The fallback keeps the game valid after budget exhaustion, a non-retryable upstream error, or exhausted backend retries. Retryable failures that recover inside the backend produce a normal successful result to the agent.

The oracle also disables SDK retries. It makes one logical proxy request per turn and relies on the backend retry policy before applying its terminal fallback.

## Student documentation

Add `docs/students/llm.md` and link it from the student index, getting-started flow, and agent-interface guide. Compose it into every template.

The guide covers:

- Requesting or rotating a development key for one season.
- Setting only `OPENAI_BASE_URL` and `OPENAI_API_KEY` in `.env`.
- Choosing a literal enabled model tier in the smoke command and agent code.
- Keeping the key outside Git and rotating it after exposure.
- The separate per-participant, per-season development allowance.
- Successful-only metering and recording.
- Backend retries and the terminal errors agent fallback code must handle.
- Public official metadata, owner and operator access to official prompt bodies, and participant and operator access to development prompt bodies.
- The rule that development calls never enter recordings or leaderboards.
- The unsupported streaming mode.

The template README points to this guide and the smoke command.

## Tests

Docker-free Python tests cover:

- A two-agent fixture sees its own key at import, construction, reset, act, chat, and learn, including a client captured during construction.
- Acting keys alternate correctly across a multi-agent episode.
- Setup and per-tick markers use the explicit tick URL and matching slot key, and precede the participant hooks they describe.
- A failed marker request emits a diagnostic and does not stop the episode.
- Setup calls persist with null ticks, and per-turn calls persist with the marked tick.
- Backend retry time inside an `act` call contributes to decision, step, and episode timing. Calls from `chat` and `learn` contribute to their corresponding hook timing and the same limits.
- The oracle follows a valid completion and uses its legal fallback for malformed output, `budget_exceeded`, a non-retryable API error, and an exhausted-retry error.
- A retryable upstream failure followed by backend success reaches the oracle as one successful response.
- Dispatcher help lists `llm`, dispatches `python -m sandbox llm` to `sandbox.llm_example`, forwards extra arguments, and selects the LLM-specific dependency probe. Both a current interpreter and a pre-existing `.venv` with game dependencies but without `openai` or `dotenv` take the repair path before dispatch.
- The updated `llm_example.py`, `.env.example`, dispatcher command, oracle tests, and READMEs pass through template composition, with no generated documentation retaining `python -m sandbox.llm_example` or `OPENAI_MODEL`.
- The non-LLM harness path preserves the deterministic recording fixtures.

## Done when

- Every participant hook runs with the correct slot's base URL and key.
- Every successful official SQLite row following a successful ownership marker has the correct session, slot, and setup or tick attribution. A failed marker follows the logged availability exception above.
- LLM wait time during `act`, `chat`, and `learn`, including backend retries, is included in the existing timing limits.
- A student runs `python -m sandbox llm [small|medium|large]` and the Hearts oracle with a season development key stored in `.env`.
- The same oracle runs in an official session with injected credentials and unchanged agent code.
- The guide explains key handling, separate development limits, successful-only accounting, retry behavior, visibility, and fallback errors.
