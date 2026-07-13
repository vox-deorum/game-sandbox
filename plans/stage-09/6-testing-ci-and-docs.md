# Stage 9.6: Testing, CI, and Documentation

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 6.

## Outcome

Full-stack integration and browser journeys verify retries, successful-only accounting, official and development meter isolation, key lifecycle, network isolation, telemetry privacy, and disabled-session regressions. Contributor and student documentation describe the delivered API and configuration directly.

## Stub upstream

Extend the backend integration and Playwright harnesses with one OpenAI-compatible stub upstream. A request fixture selects deterministic behavior without changing the proxy contract:

- Immediate success with known model and usage fields.
- A configured sequence of retryable responses followed by success.
- A non-retryable 4xx response.
- Retryable responses through the configured retry limit.
- A successful response with missing or malformed usage for tiktoken fallback.
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
- Failed logical requests remain in the rate window even though they consume no call or token allowance, and backend retries do not add rate events.
- Requests using either supported completion-limit field reserve and forward the enforced output maximum, while omitted limits receive the configured default.
- Missing or malformed upstream usage produces explicitly marked tiktoken estimates in one successful row.
- Successful SQLite rows carry the acting slot and tick.
- A forced exit during a delayed upstream call blocks new admission, aborts or drains the active request, settles its reservation, and only then aggregates or deletes telemetry.
- The saved slot key returns 401 after exit, and teardown removes the session network and relay attachment.

### Development access

Create two active participants and two LLM-enabled seasons. Request and use development keys to prove that:

- Each `(participant, season)` pair has an independent call, token, and rate allowance.
- Rotating one key invalidates its previous secret without resetting usage.
- A successful request creates one private ledger row with full bodies, retry-inclusive latency, and an accurate estimated-usage marker.
- A non-retryable error and exhausted retry sequence create no usage and no ledger row.
- Development calls create no official execution-scope row, game result, placement, or board usage.
- Official calls do not change development totals.

### Leaderboard run

Run two workflow matches under a small per-submission run allowance. Confirm successful usage carries across matches for one submission, remains independent for another submission, and produces exact run-SQLite, game-result, board, and placement aggregates, including estimated-call counts. The first over-budget request is rejected without an upstream attempt or telemetry row, and the agent completes the game without forfeiting.

### Disabled sessions

Run the existing deterministic Spades and Flappy Bird fixtures with effective LLM access disabled. Their launch configs, network mode, environment variables, hook order, and recording bytes remain unchanged.

## Browser journeys

Add `frontend/e2e/llm.spec.ts` using the same stub upstream:

1. An operator configures allowed aliases and separate official and development limits for a season.
2. A participant opens My Profile, creates a development key, and sees the one-time credential dialog.
3. A successful development request updates only that participant's selected-season allowance and private ledger.
4. Another participant cannot read the ledger, while the operator can inspect it from season management.
5. An official oracle session produces replay model-call metadata and owner debug bodies.
6. A logged-out caller sees replay metadata but receives no request or completion bodies from the raw API.
7. The automated board shows successful calls, tokens, estimated-usage status, and model-call latency by alias.
8. No surface renders an error row for unsuccessful logical requests.

Use the existing authenticated-persona fixtures and UI primitives. Update locators and component tests in the same change as the new surfaces.

## Documentation

Update these documents to match the implementation:

- `docs/specs/llm.md`, `execution.md`, `leaderboard.md`, `submission.md`, and `recording.md` describe the final behavior and data boundaries.
- `docs/contributors/configuration.md` documents every `LLM_*` setting, including one upstream URL and key, model aliases, tiktoken encoding, default and hard output maxima, per-attempt timeout, maximum retries after the initial attempt, initial retry interval, official defaults, and development defaults.
- `docs/contributors/backend.md` describes the shared proxy handler, internal listener, public development route, grant authentication, admitted-request rate windows, retry loop, successful-call meters, tiktoken fallback, execution-scope SQLite, teardown barriers, recording-to-scope resolution, visibility, retention, and the development ledger.
- `docs/contributors/execution.md` describes the per-session internal network and backend-proxy relay.
- `docs/contributors/recordings.md` explains the durable recording association to external LLM telemetry. The recording schema remains unchanged.
- `docs/contributors/index.md` lists LLM proxy code under the backend and contains no standalone gateway component.
- `docs/students/llm.md` documents season key creation, `.env`, model aliases, development limits, backend retries, terminal error handling, successful-only accounting, and privacy.
- The template README points to the student guide and `python -m sandbox llm`.

Run the strict docs build and link checks. Update the Stage 9 overview and all subplan statuses when the implementation and verification gates pass.

## CI gates

The Docker-free default lane runs backend proxy, retry, meter, schema, storage, harness, template, and frontend unit tests. The Docker integration lane runs network and end-to-end official and development journeys. The Playwright lane runs the browser visibility and key-management journey.

Keep the stub upstream local to the test process so CI requires no external provider credential or network service.

## Done when

- Docker-free tests cover every retry class, compatible error path, rate-event retention, completion-limit normalization, tiktoken fallback, reservation release, meter failure circuit breaking, successful-only record sink, authorization boundary, and UI state.
- Docker integration proves official and development flows against one stub upstream, including network isolation and exact cross-artifact accounting.
- Playwright proves participant, owner, public, and operator visibility at both UI and raw-API boundaries.
- Disabled-session fixtures remain deterministic and byte-identical.
- Contributor and student documentation matches the delivered routes, settings, limits, retry behavior, and privacy model.
- `uv run python scripts/ci.py docs`, the standard CI lanes, the Docker integration lane, and the frontend end-to-end lane pass.
