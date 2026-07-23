# Stage 9.7: Testing, CI, and Documentation

Status: in progress.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 7.

## Outcome

Full-stack integration and browser journeys verify retries, successful-only accounting, meter isolation, key lifecycle, network isolation, telemetry privacy, proxy-time discounts, and disabled-session regressions. Contributor and student documentation describes the delivered API and configuration directly.

## Stub upstream

`backend/test/integration/workflow-llm-budget.test.ts` already stands up an in-process Fastify server as a local OpenAI-compatible upstream. Promote it to one shared stub used by both harnesses: the backend integration suite keeps running it in process, and the Playwright setup (`frontend/e2e/fresh-backend.mjs`) spawns it as a small standalone process and points the spawned backend at it through `LLM_UPSTREAM_URL` and the related `LLM_*` settings. A request fixture selects deterministic behavior without changing the proxy contract:

- Immediate success with known model and usage fields.
- A configured sequence of retryable responses followed by success.
- A non-retryable 4xx response.
- Retryable responses through the configured retry limit.
- A successful response with missing or malformed usage for tiktoken fallback.
- Request and completion content that resembles tokenizer special tokens.
- A successful response with provider-specific metadata beside standard generated content.
- A delayed response for timeout and timing checks.

The stub records upstream attempts, arrival times, model names, and authorization headers. Assertions verify tier mapping and exponential intervals, and that the backend credential reaches the upstream while participant and slot keys do not.

## Docker integration journeys

Add these journeys to the Docker-gated `backend-integration` lane under `backend/test/integration/`:

### Official session

Start a live session in an LLM-enabled Hearts season and drive a mix of upstream outcomes through the stub. Confirm that:

- The container reaches the backend proxy and cannot reach the public internet.
- A retryable sequence followed by success produces one successful response, the expected weighted-token charge, and one SQLite row whose latency includes attempts and waits.
- A non-retryable error makes one upstream attempt and produces no charge or SQLite row.
- Exhausted retries make the configured number of attempts and produce no charge or SQLite row.
- Failed logical requests release their pending rate capacity and record no event, while backend retries reserve no additional capacity.
- Requests using either supported completion-limit field reserve and forward the enforced output maximum, while omitted limits receive the configured default.
- Missing or malformed upstream usage produces explicitly marked tiktoken estimates in one successful row.
- Successful SQLite rows carry the acting slot and tick.
- Per-slot inflight reads discount successful, retried, and terminal proxy calls from hook, step, and episode timing. Failed reads charge full wall time.
- Live-session and workflow watchdogs use the same post-arm discount, cap active-request credit, and leave idle timeout on wall-clock time.
- Every normal, failed-launch, crash, stop, and forced-exit path first closes grants to new admission, then aborts or drains active requests and awaits every reservation finalizer. Aggregation, telemetry deletion, network removal, and lifecycle completion happen only after that barrier resolves.
- The saved slot key returns 401 after exit, and teardown removes the session network and relay attachment.

### Development access

Create two active participants and two LLM-enabled seasons. Request and use development keys to prove that:

- Each `(participant, season)` pair has an independent token and rate allowance.
- Successful logical requests occupy one event in only that pair's sliding rate window. Terminal failures release their pending capacity, while upstream retry attempts reserve no additional capacity.
- Rotating one key invalidates its previous secret without resetting usage.
- Closing a season's submissions blocks completion calls and key rotation for existing credentials. Reopening submissions restores access under the current policy.
- A successful request creates one private ledger row with the accepted request and canonical completion, retry-inclusive latency, and an accurate estimated-usage marker.
- A non-retryable error and exhausted retry sequence create no usage and no ledger row.
- A forced post-upstream accounting failure returns `meter_unavailable`, retains conservative charged debt, and opens only that pair's accounting breaker. Rejected requests make no upstream attempt. Failed single-flight health probes keep it open, and a later committed write-health probe restores admission without forgiving the debt or changing another pair's state.
- Development calls create no official execution-scope row, game result, placement, or board usage.
- Official calls do not change development totals.

### Leaderboard run

Extend the existing `workflow-llm-budget.test.ts`, which already proves that an over-budget request inside a match is rejected without an upstream attempt or telemetry row and that the agent completes the game without forfeiting. Run two workflow matches under a small per-slot allowance. Confirm each slot in each match meters independently, a submission's second match starts with a fresh per-slot allowance, and the run produces exact run-SQLite, game-result, board, and placement aggregates, including estimated-call counts. Change the season configuration between matches and confirm that the active run continues to use its frozen official model and limit policy. A Docker-free recovery test reloads the persisted run through a workflow runner constructed with different deployment defaults and proves that it still reads only `llm_policy_snapshot`.

Force workflow success, failure, cancellation, and worker-shutdown exits while an upstream request is delayed. Each path closes admission and settles all authenticated work before querying run telemetry or persisting game-result, board, and placement aggregates. Assert that no late row appears after those artifacts are written.

### Disabled sessions

Run the existing deterministic Spades and Flappy Bird coverage (the `spades-chat.test.ts` journey and the fixtures produced by `scripts/gen_spades_fixture.py` and `scripts/gen_flappy_fixture.py`) with effective LLM access disabled. Their launch configs, network mode, environment variables, hook order, and recording bytes remain unchanged.

## Browser journeys

Extend the released Black Lady Open workflow in `frontend/e2e/hearts.spec.ts` against the same stub upstream, spawned and wired into the backend by `fresh-backend.mjs`. Oracle competes beside one non-LLM submission in both ordered seatings, so one season covers development access, official workflow accounting, board aggregation, and retained replay telemetry:

1. An operator configures available model tiers and separate official and development limits for a season.
2. A participant sees the eligible current-season usage meter and layered key action on My Agents, then opens the owner-only agent-profile Development access section with resolved model prices, used and remaining budget units, and call-history action.
3. Creating a key opens the one-time credential dialog with working copy actions for `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and the combined `.env` text. Rotating an existing key first requires confirmation that the old key will stop working, then replaces it without resetting usage. Closing the dialog clears the secret from UI state.
4. A successful development request updates only that participant's current-season meter and private call history. Another participant cannot read it. Expanded historical submission rows keep closed-season history reachable.
5. Season management shows a compact participant summary table. Selecting a participant row opens the shared call-history dialog.
6. An official Oracle workflow game shows an `LLM cost` column beside `Decision` in the existing replay `DecisionLog`. Multiple null-tick slots render in a separate leading setup-cost row group with stable `setup:<slot>` IDs, while scrubbing still highlights and scrolls to the correct unchanged decision index. `RunMetadata` shows the recording's stored total budget cost.
7. Every populated cost tooltip exposes successful calls and model tiers, stored cost weights, input-plus-output token bases, reasoning-token subsets, and authoritative budget costs. Its trigger and content are programmatically associated, pointer hover persists across both, keyboard focus opens it, Escape dismisses it without moving focus, and touch exposes the same details.
8. The current submission owner and an operator can use the exact `Inspect request and response` action from the replay cost cell. The dialog is keyboard operable, traps and restores focus, and exposes the exact `Request` and `Response` headings. A logged-out caller sees costs and other public metadata but receives no bodies from the UI or raw API.
9. Deleting the controlling submission retains official telemetry and public budget costs. Its former owner sees masked rows and cannot open bodies through the replay UI or raw API, while an operator can still inspect bodies on the retained recording.
10. The mixed automated board uses one summary-first `LLM usage` line with successful calls, tokens, and stored budget cost units for Oracle, while non-LLM rows show `None`. A `By model` disclosure provides the `small` tier breakdown without changing rank.
11. An ordinary non-LLM replay and an LLM-enabled replay with no successful calls both render `None` in the `LLM cost` column without an error state. Unsuccessful logical requests never appear as calls or costs.
12. A replay whose telemetry endpoint returns `500 telemetry_unavailable` still loads the recording and game. It shows a danger `UiEmptyState` reading `LLM cost data unavailable.`, omits the LLM cost total from `RunMetadata`, and renders `Unavailable` rather than `None` in every decision cost cell.
13. Replay, board, development, and operator dialog surfaces remain usable at the supported narrow-screen breakpoint. Cost tooltips, disclosures, dialogs, pagination, copy controls, and confirmation remain usable by keyboard and touch.

Use the existing authenticated-persona fixtures (`admin` and `as(handle)` in `frontend/e2e/support/fixtures.ts`) and UI primitives. Update locators and component tests in the same change as the new surfaces.

## Documentation

Steps 1 through 6 already delivered most of the written documentation: `docs/contributors/configuration.md` documents every `LLM_*` setting, `docs/students/llm.md` covers key creation, the two-variable `.env`, fixed model tiers and prices, development limits, retries, terminal errors, successful-only accounting, and privacy, the template READMEs point to the student guide and `python -m sandbox llm [small|medium|large]`, `docs/contributors/index.md` lists the LLM proxy under the backend with no standalone gateway component, and `docs/contributors/backend.md` records the flat application-schema policy (edit the single initial migration in place, no forward migration, contributors with an older local database recreate it). This step verifies those pages against the final implementation and fills the remaining gaps:

- `docs/specs/llm.md`, `execution.md`, `leaderboard.md`, `submission.md`, and `recording.md` describe the final behavior and data boundaries.
- `docs/contributors/backend.md` describes the shared proxy handler, standard response-metadata boundary, internal listener and inflight route, public development route, grant authentication, synchronous reader-and-sink binding, generic per-accounting-scope admitted-request windows, retry loop, successful-call meters, post-upstream conservative debt, automatic write-health recovery, tiktoken fallback, execution-scope SQLite and its cost-basis migration, teardown barriers, frozen workflow policy, recording-to-scope resolution, empty and unavailable telemetry responses, visibility after submission deletion, retention, and the development ledger. Its flat-schema guidance stays distinct from the `PRAGMA user_version` migrations used by per-scope telemetry and development-ledger files.
- `docs/contributors/execution.md` gains the per-session internal network, backend-proxy relay, and fail-closed proxy-time discount contract.
- `docs/contributors/recordings.md` gains the durable recording association to external LLM telemetry. The recording schema remains unchanged.

Run the strict docs build. Update the Stage 9 overview and this file's status when the implementation and verification gates pass.

## CI gates

The Docker-free lanes already run the unit suites from steps 1 through 6: `python` covers the harness and template tests, including the dispatcher help, LLM dependency probe, and stale-venv repair path, and `typescript` covers the backend proxy, retry, meter, schema, storage, and frontend unit tests, creating the application database from an empty path so tests exercise the flat schema rather than a forward migration. This step extends the two Docker-gated lanes: `backend-integration` gains the network and end-to-end official and development journeys, and `frontend-e2e` gains the mixed-workflow browser visibility and key-management journey. The E2E data directory, including its external telemetry files, is copied as one snapshot when it becomes the local demo fixture.

Keep the stub upstream local to the test harness so CI requires no external provider credential or network service.

## Done when

- Docker-free tests, delivered in steps 1 through 6 and extended here where this step finds gaps, cover every retry class, compatible error path, response-metadata sanitization, generic per-scope rate-event retention, completion-limit normalization, ordinary-content tiktoken fallback, reservation release, post-upstream meter and ledger failure circuit breaking and automatic health recovery, successful-only record sink, frozen workflow policy, authorization boundary, fresh flat-schema creation, and UI state.
- Docker integration proves official and development flows against one stub upstream, including network isolation, teardown-before-aggregation ordering on every workflow exit, and exact cross-artifact accounting.
- Playwright proves participant, current owner, former owner, public, and operator visibility at both UI and raw-API boundaries, including authoritative budget costs, setup-row index stability, successful empty telemetry, `telemetry_unavailable`, exact inspector labels, key handling, tooltip accessibility, touch access, keyboard access, and narrow-screen access.
- Disabled-session fixtures remain deterministic and byte-identical.
- Contributor and student documentation matches the delivered routes, settings, limits, retry behavior, and privacy model.
- `uv run python scripts/ci.py all` (which includes the `python`, `typescript`, and `docs` lanes) and the Docker-gated `backend-integration` and `frontend-e2e` lanes pass.
