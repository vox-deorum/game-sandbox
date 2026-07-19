# Stage 9.7: Testing, CI, and Documentation

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 7.

## Outcome

Full-stack integration and browser journeys verify retries, successful-only accounting, official and development meter isolation, key lifecycle, network isolation, telemetry privacy, and disabled-session regressions. Contributor and student documentation describe the delivered API and configuration directly.

## Stub upstream

Extend the backend integration and Playwright harnesses with one OpenAI-compatible stub upstream. A request fixture selects deterministic behavior without changing the proxy contract:

- Immediate success with known model and usage fields.
- A configured sequence of retryable responses followed by success.
- A non-retryable 4xx response.
- Retryable responses through the configured retry limit.
- A successful response with missing or malformed usage for tiktoken fallback.
- Request and completion content that resembles tokenizer special tokens.
- A successful response with provider-specific metadata beside standard generated content.
- A delayed response for timeout and timing checks.

The stub records upstream attempts, arrival times, model names, and authorization headers. Assertions verify exponential intervals, alias mapping, and that the backend credential reaches the upstream while participant and slot keys do not.

## Docker integration journeys

Add these journeys to the Docker-gated `backend-integration` lane:

### Official session

Run an LLM-enabled session with the Hearts oracle and a mix of upstream outcomes. Confirm that:

- The container reaches the backend proxy and cannot reach the public internet.
- A retryable sequence followed by success produces one successful response, one call charge, and one SQLite row whose latency includes attempts and waits.
- A non-retryable error makes one upstream attempt and produces no charge or SQLite row.
- Exhausted retries make the configured number of attempts and produce no charge or SQLite row.
- Failed logical requests release their pending rate capacity and record no event, while backend retries reserve no additional capacity.
- Requests using either supported completion-limit field reserve and forward the enforced output maximum, while omitted limits receive the configured default.
- Missing or malformed upstream usage produces explicitly marked tiktoken estimates in one successful row.
- Successful SQLite rows carry the acting slot and tick.
- Every normal, failed-launch, crash, stop, and forced-exit path first closes grants to new admission, then aborts or drains active requests and awaits every reservation finalizer. Aggregation, telemetry deletion, network removal, and lifecycle completion happen only after that barrier resolves.
- The saved slot key returns 401 after exit, and teardown removes the session network and relay attachment.

### Development access

Create two active participants and two LLM-enabled seasons. Request and use development keys to prove that:

- Each `(participant, season)` pair has an independent call, token, and rate allowance.
- Successful logical requests occupy one event in only that pair's sliding rate window. Terminal failures release their pending capacity, while upstream retry attempts reserve no additional capacity.
- Rotating one key invalidates its previous secret without resetting usage.
- A successful request creates one private ledger row with the accepted request and canonical completion, retry-inclusive latency, and an accurate estimated-usage marker.
- A non-retryable error and exhausted retry sequence create no usage and no ledger row.
- A forced post-upstream accounting failure returns `meter_unavailable`, retains conservative charged debt, and opens only that pair's accounting breaker. Rejected requests make no upstream attempt. Failed single-flight health probes keep it open, and a later committed write-health probe restores admission without forgiving the debt or changing another pair's state.
- Development calls create no official execution-scope row, game result, placement, or board usage.
- Official calls do not change development totals.

### Leaderboard run

Run two workflow matches under a small per-slot allowance. Confirm each slot in each match meters independently, a submission's second match starts with a fresh per-slot allowance, and the run produces exact run-SQLite, game-result, board, and placement aggregates, including estimated-call counts. Change the season configuration between matches and confirm that the active run continues to use its frozen official model and limit policy. A Docker-free recovery test reloads the persisted run through a workflow runner constructed with different deployment defaults and proves that it still reads only `llm_policy_snapshot`. An over-budget request inside a match is rejected without an upstream attempt or telemetry row, and the agent completes the game without forfeiting.

Force workflow success, failure, cancellation, and worker-shutdown exits while an upstream request is delayed. Each path closes admission and settles all authenticated work before querying run telemetry or persisting game-result, board, and placement aggregates. Assert that no late row appears after those artifacts are written.

### Disabled sessions

Run the existing deterministic Spades and Flappy Bird fixtures with effective LLM access disabled. Their launch configs, network mode, environment variables, hook order, and recording bytes remain unchanged.

## Browser journeys

Add `frontend/e2e/llm.spec.ts` using the same stub upstream:

1. An operator configures allowed aliases and separate official and development limits for a season.
2. A participant opens My Profile and sees a summary-first Development access section populated from eligible-season discovery, including resolved model cost weights and remaining budget units, before creating a key. Call history loads separately.
3. Creating a key opens the one-time credential dialog with working copy actions for `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and the combined `.env` text. Rotating an existing key first requires confirmation that the old key will stop working, then replaces it without resetting usage. Closing the dialog clears the secret from UI state.
4. A successful development request updates only that participant's selected-season allowance and private call history, with estimates labeled. Another participant cannot read it.
5. Season management shows a compact participant summary table. Selecting View calls opens a separate detail region for the operator, with estimates labeled, rather than nesting history inside the table.
6. An official oracle session shows an `LLM cost` column beside `Decision` in the existing replay `DecisionLog`. Multiple null-tick slots render in a separate leading setup-cost row group with stable `setup:<slot>` IDs, while scrubbing still highlights and scrolls to the correct unchanged decision index. `RunMetadata` shows the recording's stored total budget cost.
7. Every populated cost tooltip exposes successful calls and aliases, stored cost weights, input-plus-output token bases, reasoning-token subsets, estimate status, and authoritative budget costs. Its trigger and content are programmatically associated, pointer hover persists across both, keyboard focus opens it, Escape dismisses it without moving focus, and touch exposes the same details.
8. The current submission owner and an operator can use the exact `Inspect request and response` action from the replay cost cell. The dialog is keyboard operable, traps and restores focus, and exposes the exact `Request` and `Response` headings. A logged-out caller sees costs and other public metadata but receives no bodies from the UI or raw API.
9. Deleting the controlling submission retains official telemetry and public budget costs. Its former owner sees masked rows and cannot open bodies through the replay UI or raw API, while an operator can still inspect bodies on the retained recording.
10. The automated board uses one summary-first `LLM usage` line with successful calls, tokens, stored budget cost units, and estimate status. A `By model` disclosure provides the breakdown without changing rank.
11. An ordinary non-LLM replay and an LLM-enabled replay with no successful calls both render `None` in the `LLM cost` column without an error state. Unsuccessful logical requests never appear as calls or costs.
12. A replay whose telemetry endpoint returns `500 telemetry_unavailable` still loads the recording and game. It shows a danger `UiEmptyState` reading `LLM cost data unavailable.`, omits the LLM cost total from `RunMetadata`, and renders `Unavailable` rather than `None` in every decision cost cell.
13. Replay, board, development, and operator detail surfaces remain usable at the supported narrow-screen breakpoint. Cost tooltips, disclosures, dialogs, pagination, copy controls, and confirmation remain usable by keyboard and touch.

Use the existing authenticated-persona fixtures and UI primitives. Update locators and component tests in the same change as the new surfaces.

## Documentation

Update these documents to match the implementation:

- `docs/specs/llm.md`, `execution.md`, `leaderboard.md`, `submission.md`, and `recording.md` describe the final behavior and data boundaries.
- `docs/contributors/configuration.md` documents every `LLM_*` setting, including the validated upstream base URL and key, model aliases, default model prices, ordinary-content tiktoken encoding, default and hard output maxima, per-attempt timeout, maximum retries after the initial attempt, initial retry interval, meter recovery interval, official defaults, and development defaults. It also identifies the backend OpenAI client and tiktoken packages and the template's pinned Python OpenAI dependencies.
- `docs/contributors/backend.md` describes the shared proxy handler, standard response-metadata boundary, internal listener, public development route, grant authentication, synchronous reader-and-sink binding, generic per-accounting-scope admitted-request windows, retry loop, successful-call meters, post-upstream conservative debt, automatic write-health recovery, tiktoken fallback, execution-scope SQLite and its cost-basis migration, teardown barriers, frozen workflow policy, recording-to-scope resolution, empty and unavailable telemetry responses, visibility after submission deletion, retention, and the development ledger.
- `docs/contributors/execution.md` describes the per-session internal network and backend-proxy relay.
- `docs/contributors/recordings.md` explains the durable recording association to external LLM telemetry. The recording schema remains unchanged.
- `docs/contributors/index.md` lists LLM proxy code under the backend and contains no standalone gateway component.
- `docs/students/llm.md` documents season key creation, `.env`, model aliases and prices, development limits, backend retries, terminal error handling, successful-only accounting, and privacy.
- The template README points to the student guide and `python -m sandbox llm`.

Document the repository's pre-production database policy next to the storage setup instructions. Stage 9 edits the flat initial application-database schema directly, does not add a forward migration, and requires contributors with an older local database to recreate it. Keep this guidance distinct from `PRAGMA user_version` migrations for per-scope telemetry and development-ledger files.

Run the strict docs build and link checks. Update the Stage 9 overview and all subplan statuses when the implementation and verification gates pass.

## CI gates

The Docker-free default lane runs backend proxy, retry, meter, schema, storage, harness, template, and frontend unit tests. It creates the application database from an empty path and verifies the resulting flat schema rather than exercising a forward migration. It also verifies that `backend/package.json` and the root `package-lock.json` contain the backend OpenAI client and tiktoken dependencies, and that the template's pinned requirements, dispatcher help, LLM dependency probe, and stale-venv repair path agree. The Docker integration lane runs network and end-to-end official and development journeys. The Playwright lane runs the browser visibility and key-management journey.

Keep the stub upstream local to the test process so CI requires no external provider credential or network service.

## Done when

- Docker-free tests cover every retry class, compatible error path, response-metadata sanitization, generic per-scope rate-event retention, completion-limit normalization, ordinary-content tiktoken fallback, reservation release, post-upstream meter and ledger failure circuit breaking and automatic health recovery, successful-only record sink, frozen workflow policy, authorization boundary, dependency configuration, fresh flat-schema creation, and UI state.
- Docker integration proves official and development flows against one stub upstream, including network isolation, teardown-before-aggregation ordering on every workflow exit, and exact cross-artifact accounting.
- Playwright proves participant, current owner, former owner, public, and operator visibility at both UI and raw-API boundaries, including authoritative budget costs, setup-row index stability, successful empty telemetry, `telemetry_unavailable`, exact inspector labels, key handling, tooltip accessibility, touch access, keyboard access, and narrow-screen access.
- Disabled-session fixtures remain deterministic and byte-identical.
- Contributor and student documentation matches the delivered routes, settings, limits, retry behavior, and privacy model.
- `uv run python scripts/ci.py docs`, the standard CI lanes, the Docker integration lane, and the frontend end-to-end lane pass.
