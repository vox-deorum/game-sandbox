# Stage 9.3: Harness Credentials and the Template LLM Example

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 3: the participant-facing payoff. The harness starts setting `OPENAI_BASE_URL` and the acting slot's `OPENAI_API_KEY`, and the template grows a worked example agent that consults the model. Almost entirely Python — the backend work of steps 1 and 2 is consumed, not extended.

**Hands-on result:** the stage's headline "done when" — the same student code runs unmodified locally against the instructor's class key in `.env` and inside a session against the gateway, because both places present the identical two environment variables.

## Why this is its own seam

- The credential swap is the one piece of the stage inside the per-turn loop, where correctness rules are strict and already pinned: byte-identical recordings when a capability is off (the Stage 8 chat precedent), failures charged to the right seat, wall-clock timing as the single budget basis. A Docker-free step keeps those invariants testable on `ManualClock` and fixture agents.
- The example agent belongs in the same step because it proves the contract is usable — and [submission.md](../../docs/specs/submission.md) promises every starter kit "a minimal LLM API example," which is only honest once the in-session half actually works.

## What to build

### Config plumbing

`live.py::parse_config` learns the `llm` block step 2 already emits: `base_url` and a per-slot `keys` map onto `LiveConfig.llm`, absent meaning disabled. The lockstep note with `backend/src/session/launch-config.ts` covers the new shape.

### The credential swap

A small helper (e.g. `set_slot_credentials(llm, slot_id)`) owns the only two `os.environ` writes in the harness: `OPENAI_BASE_URL` set once at startup, and `OPENAI_API_KEY` swapped to the acting slot's key at each point where participant code is about to run:

- Around `load_agent` in `live.py::build_slots` — an agent that constructs its `OpenAI()` client at import or `__init__` time captures its own slot's key, because module import happens inside `load_agent` with that slot's credentials in place.
- Around each slot's `reset` in `Episode.start`.
- At the top of the acting-slot branch of `Episode.step_once` — one set per step covers `act`, `chat`, and `learn`, since all three hooks belong to the same slot.

Constraints and non-goals:

- Agents run sequentially in one process (the documented Stage 2 assumption in `manifest.py`), so a single mutable env var attributes every call correctly.
- The keys are telemetry and budget attribution, not an intra-container security boundary — [execution.md](../../docs/specs/execution.md) already accepts that agents sharing a container can interfere; nothing here claims otherwise.
- With no `llm` block, no statement of any of this runs — the same guarded-by-existence pattern as the chat router — and the existing determinism fixtures are the regression gate that recordings stay byte-identical.
- No new timing machinery: an LLM call blocks inside `act`, so its wall-clock time already lands in `decision_ms`, the slot's `budget_used_ms`, and the step and episode limits. This step pins that with a test, making [llm.md](../../docs/specs/llm.md)'s "time waiting for a model counts toward the agent's limits" a tested sentence.

### The template surface

- **Smoke command**: `templates/base/sandbox/llm_example.py` stops hardcoding `gpt-4o-mini` — the model comes from `OPENAI_MODEL` (defaulted, documented), since the deployment's allowlist, not the template, decides what names exist. `templates/base/.env.example` gains the `OPENAI_MODEL` line, and `python -m sandbox llm` joins the `__main__.py` dispatch so the smoke test is one command instead of a module path.
- **Worked example**: `examples/hearts/oracle/` — each turn it builds a compact prompt from the observation via the existing cards helper, asks the model which legal card to play, parses the answer, and falls back to the lowest legal card on **any** failure, malformed replies and API errors alike. Hearts because it is unpaced (multi-second latency fits under a season's raised step limits) and simpler than Spades. The fallback is the pedagogical core: working code demonstrating the exact contract the spec promises — an over-budget or failed call is an ordinary catchable error and the episode continues.
- **Student docs**: a new `docs/students/llm.md` ("Using the LLM API") covering the two env vars and the `.env` flow, the model list coming from the deployment, the error-handling pattern, no streaming, and the visibility warning — call metadata is public on replays; full prompts are visible to you and to operators. Linked from `agent-interface.md` and the getting-started flow, composed into templates by the existing docs machinery.

## Tests

Docker-free Python on fixture agents and stub servers:

- A fixture agent that records `os.environ` at import, `__init__`, `reset`, `act`, `chat`, and `learn` sees its own slot's key at every point, in a two-agent episode where the acting key visibly alternates.
- A client constructed at `__init__` and used at `act` keeps working across other slots' turns (the captured-at-construction case the swap is designed around).
- With no `llm` config, the environment is untouched and recordings are byte-identical to pre-stage fixtures.
- A slow fake LLM call inside `act` charges `decision_ms` and the episode budget, and can trip the step and episode limits — the timing pin.
- The oracle example, pointed at a local stub OpenAI server: plays the suggested card on a well-formed reply; falls back to lowest-legal on a malformed reply, on a `budget_exceeded`-shaped 400, and on a connection error, finishing the episode in all cases; the stock `openai` client maps the step 1 error envelope to `BadRequestError` (the cross-language contract test).
- `python -m sandbox llm` and the example's tests pass through the composed-template machinery like every other example.

## Done when

- A student copies `.env.example`, fills in the class key, and `python -m sandbox llm` answers; the oracle example plays a full local Hearts hand through `play.py`, consulting the model each turn.
- The same oracle, submitted and watched in a session against an LLM-enabled season, plays through the gateway with no code change — from the agent's point of view nothing distinguishes the two beyond the values of two environment variables.
- Every slot's calls carry its own key; LLM wait time lands in the recorded timing; sessions without the capability are byte-identical to today.
- The student docs teach the env vars, the fallback pattern, and the visibility rules.
- All green Docker-free; the in-session run is the step's hands-on check against a locally running stack.
