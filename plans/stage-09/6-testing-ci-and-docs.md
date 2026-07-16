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
- Failed logical requests remain in the rate window even though they consume no call or token allowance, and backend retries do not add rate events.
- Requests using either supported completion-limit field reserve and forward the enforced output maximum, while omitted limits receive the configured default.
- Missing or malformed upstream usage produces explicitly marked tiktoken estimates in one successful row.
- Successful SQLite rows carry the acting slot and tick.
- Every normal, failed-launch, crash, stop, and forced-exit path first closes grants to new admission, then aborts or drains active requests and awaits every reservation finalizer. Aggregation, telemetry deletion, network removal, and lifecycle completion happen only after that barrier resolves.
- The saved slot key returns 401 after exit, and teardown removes the session network and relay attachment.

### Development access

Create two active participants and two LLM-enabled seasons. Request and use development keys to prove that:

- Each `(participant, season)` pair has an independent call, token, and rate allowance.
- Successful and terminally failed logical requests each occupy one event in only that pair's sliding rate window, while upstream retry attempts add no events.
- Rotating one key invalidates its previous secret without resetting usage.
- A successful request creates one private ledger row with the accepted request and canonical completion, retry-inclusive latency, and an accurate estimated-usage marker.
- A non-retryable error and exhausted retry sequence create no usage and no ledger row.
- A forced post-upstream accounting failure returns `meter_unavailable`, retains conservative charged debt, and opens only that pair's accounting breaker. Rejected requests make no upstream attempt. Failed single-flight health probes keep it open, and a later committed write-health probe restores admission without forgiving the debt or changing another pair's state.
- Development calls create no official execution-scope row, game result, placement, or board usage.
- Official calls do not change development totals.

### Leaderboard run

Run two workflow matches under a small per-submission run allowance. Confirm successful usage carries across matches for one submission, remains independent for another submission, and produces exact run-SQLite, game-result, board, and placement aggregates, including estimated-call counts. Change the season configuration between matches and confirm that the active run continues to use its frozen official model and limit policy. A Docker-free recovery test reloads the persisted run through a workflow runner constructed with different deployment defaults and proves that it still reads only `llm_policy_snapshot`. The first over-budget request is rejected without an upstream attempt or telemetry row, and the agent completes the game without forfeiting.

Force workflow success, failure, cancellation, and worker-shutdown exits while an upstream request is delayed. Each path closes admission and settles all authenticated work before querying run telemetry or persisting game-result, board, and placement aggregates. Assert that no late row appears after those artifacts are written.

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
7. Deleting the controlling submission retains official telemetry and public metadata, but its former owner no longer receives request or completion bodies from either the replay UI or raw API.
8. The automated board shows successful calls, tokens, estimated-usage status, and model-call latency by alias.
9. No surface renders an error row for unsuccessful logical requests.

Use the existing authenticated-persona fixtures and UI primitives. Update locators and component tests in the same change as the new surfaces.

## Documentation

Update these documents to match the implementation:

- `docs/specs/llm.md`, `execution.md`, `leaderboard.md`, `submission.md`, and `recording.md` describe the final behavior and data boundaries.
- `docs/contributors/configuration.md` documents every `LLM_*` setting, including the validated upstream base URL and key, model aliases, ordinary-content tiktoken encoding, default and hard output maxima, per-attempt timeout, maximum retries after the initial attempt, initial retry interval, meter recovery interval, official defaults, and development defaults. It also identifies the backend OpenAI client and tiktoken packages and the template's pinned Python OpenAI dependencies.
- `docs/contributors/backend.md` describes the shared proxy handler, standard response-metadata boundary, internal listener, public development route, grant authentication, synchronous reader-and-sink binding, generic per-accounting-scope admitted-request windows, retry loop, successful-call meters, post-upstream conservative debt, automatic write-health recovery, tiktoken fallback, execution-scope SQLite, teardown barriers, frozen workflow policy, recording-to-scope resolution, visibility after submission deletion, retention, and the development ledger.
- `docs/contributors/execution.md` describes the per-session internal network and backend-proxy relay.
- `docs/contributors/recordings.md` explains the durable recording association to external LLM telemetry. The recording schema remains unchanged.
- `docs/contributors/index.md` lists LLM proxy code under the backend and contains no standalone gateway component.
- `docs/students/llm.md` documents season key creation, `.env`, model aliases, development limits, backend retries, terminal error handling, successful-only accounting, and privacy.
- The template README points to the student guide and `python -m sandbox llm`.

Document the repository's pre-production database policy next to the storage setup instructions. Stage 9 edits the flat initial application-database schema directly, does not add a forward migration, and requires contributors with an older local database to recreate it. Keep this guidance distinct from `PRAGMA user_version` migrations for per-scope telemetry and development-ledger files.

Run the strict docs build and link checks. Update the Stage 9 overview and all subplan statuses when the implementation and verification gates pass.

## CI gates

The Docker-free default lane runs backend proxy, retry, meter, schema, storage, harness, template, and frontend unit tests. It creates the application database from an empty path and verifies the resulting flat schema rather than exercising a forward migration. It also verifies that `backend/package.json` and the root `package-lock.json` contain the backend OpenAI client and tiktoken dependencies, and that the template's pinned requirements, dispatcher help, LLM dependency probe, and stale-venv repair path agree. The Docker integration lane runs network and end-to-end official and development journeys. The Playwright lane runs the browser visibility and key-management journey.

Keep the stub upstream local to the test process so CI requires no external provider credential or network service.

## Done when

- Docker-free tests cover every retry class, compatible error path, response-metadata sanitization, generic per-scope rate-event retention, completion-limit normalization, ordinary-content tiktoken fallback, reservation release, post-upstream meter and ledger failure circuit breaking and automatic health recovery, successful-only record sink, frozen workflow policy, authorization boundary, dependency configuration, fresh flat-schema creation, and UI state.
- Docker integration proves official and development flows against one stub upstream, including network isolation, teardown-before-aggregation ordering on every workflow exit, and exact cross-artifact accounting.
- Playwright proves participant, current owner, former owner, public, and operator visibility at both UI and raw-API boundaries.
- Disabled-session fixtures remain deterministic and byte-identical.
- Contributor and student documentation matches the delivered routes, settings, limits, retry behavior, and privacy model.
- `uv run python scripts/ci.py docs`, the standard CI lanes, the Docker integration lane, and the frontend end-to-end lane pass.
