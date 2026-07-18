# Stage 9.2: Season Access, Development Keys, and the Session Network

Status: complete.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 2.

## Outcome

Environment metadata and season configuration resolve the allowed model aliases and separate official and development limits. Official launches receive temporary slot keys and an isolated route to the backend proxy. Active participants can request a durable development key scoped to one season and use a private per-participant meter and ledger.

The hands-on check obtains a student key for one season, makes a successful local request, and confirms that another participant and season have independent usage. A session container reaches the backend proxy and cannot reach the public internet. Its slot key stops authorizing at teardown.

## Effective LLM configuration

`EnvironmentMeta.llm` remains the environment capability flag. `resolveLlm(deployment, environment, season)` enables LLM access only when all three conditions hold:

1. The deployment configures an upstream and at least one model alias.
2. The environment sets `llm: true`.
3. The season sets `llm.enabled: true`.

When `llm.models` is absent, the season inherits every alias configured by the deployment. When it is present, it must be a non-empty subset of those aliases. Empty lists, duplicate aliases, and aliases unavailable on the deployment are rejected. Live sessions resolve the current play-open season when they start. Development keys resolve their named season against the current deployment and season configuration on every request. Submission, play, and release gates do not change development-key validity; the season's LLM configuration is the authority.

Leaderboard-run creation resolves the complete official LLM policy once and stores its JSON encoding in a dedicated non-null `season_runs.llm_policy_snapshot` text column. This column is separate from the existing strict season `config_snapshot` and is validated on write and read:

```ts
type ResolvedOfficialLlmPolicy = {
  enabled: boolean
  models: Partial<
    Record<'large' | 'medium' | 'small', { model: string; cost_weight: number }>
  >
  session: {
    token_budget: number
    call_budget: number
    rate_limit_rpm: number
  }
}
```

Each model value stores its upstream model name and token price together. New snapshots preserve the complete resolved pricing policy, while legacy snapshots with plain string model values decode with a price of 1 so they keep their original unweighted semantics. Even a disabled run stores the object, with `enabled: false` and an empty model map, so workflow code never needs a live-configuration fallback. The stored policy contains no upstream credential. Every workflow match, grant, and admission check in that run reads this policy without consulting current alias mappings, deployment limit defaults, or season LLM values. A deployment may still make the upstream operationally unavailable, but configuration changes after run creation cannot change which models, prices, or limits the run uses. The frozen limits are per agent slot; a run has no allowance of its own.

Persist the resolved official flag on the session row as `llm_enabled`. Session payloads and recording views read that stored value after execution.

Add nullable `llm_scope_id` and `llm_session_id` columns to the backend recordings table and its creation input. A live LLM recording stores its session ID in both columns. Recordings without official LLM telemetry store null. These durable fields remain available when session or workflow rows are pruned.

Stage 9 updates the application's flat initial SQLite schema directly for the run-policy column, these recording columns, and the development-key table below. The application has not been deployed with persistent production data, so it adds no forward application-database migration. Existing local application databases are recreated when this schema lands. The separate official telemetry and development-ledger files keep their own `PRAGMA user_version` handling as described in their storage plans.

## Season schema and admin editor

Define a strict `LlmOverrideSchema` in `backend/src/storage/season-config.ts`:

```ts
llm?: {
  enabled?: boolean
  models?: Array<'large' | 'medium' | 'small'>
  cost_weights?: {
    large?: number
    medium?: number
    small?: number
  }
  official?: {
    token_budget?: number
    call_budget?: number
    rate_limit_rpm?: number
  }
  development?: {
    token_budget?: number
    call_budget?: number
    rate_limit_rpm?: number
  }
}
```

Unset limits and token prices inherit deployment defaults, and an unset model list inherits every configured deployment alias. Official and development blocks resolve independently and mirror each other's shape: official limits apply per agent slot, and development limits apply per participant per season. Admin season updates reject unknown fields, non-positive limits or prices, prices above 1,000,000, empty model lists, duplicate aliases, and selected model aliases unavailable on the deployment. Run creation persists the resulting official model mapping, prices, and limits, while live and development resolution continue to use the current effective values.

`SeasonConfigEditor.vue` exposes enablement, allowed aliases, per-alias token prices, official per-slot limits, and development limits as separate field groups built from existing UI primitives. The admin-editor unit and browser tests cover every new control and validation state.

Add deployment defaults `LLM_DEVELOPMENT_TOKEN_BUDGET`, `LLM_DEVELOPMENT_CALL_BUDGET`, and `LLM_DEVELOPMENT_RATE_LIMIT_RPM`.

## Official slot keys and launch config

The orchestrator and workflow runner issue one official key for every agent slot when effective LLM access is enabled. Human slots receive no key. They construct each generic `LlmGrant` with a resolved alias-to-upstream-model map, its session-and-slot accounting scope, and one record sink. The scope reader synchronously queries a view of the same durable store updated by that sink. For live grants, the reader and sink capture the live session ID as the telemetry scope. For workflow grants, the reader and sink capture the run ID as the telemetry scope and the workflow game ID as the session filter. The registry separately associates every official key with its session for revocation and tick markers.

`backend/src/session/launch-config.ts` emits:

```json
{
  "llm": {
    "base_url": "http://llm-proxy:<port>/v1",
    "tick_url": "http://llm-proxy:<port>/internal/tick",
    "keys": {
      "player_0": "sk-sandbox-..."
    }
  }
}
```

The session and workflow launch paths share this shape. The explicit tick URL keeps the internal marker route independent from the OpenAI base path, so the harness never derives one URL from the other. Step 3 adds the matching harness parser.

Key issuance is enclosed by a teardown owner. Image, network, configuration, and driver-launch failures await grant teardown before returning. Normal exit, crash exit, explicit stop, live-session finalization, and workflow-game completion await idempotent `revokeSession`.

`revokeSession` first closes every session grant to new admission. It then aborts active upstream requests where cancellation remains safe, drains requests that have passed that boundary, and awaits every reservation finalizer. Only after this barrier resolves may a caller aggregate usage, close or delete telemetry, or report lifecycle completion. Step 5 owns telemetry file cleanup for scopes that produce no recording and for retained recordings that are deleted later.

## Student development key API

Add a persistent `llm_development_keys` table to the application database:

```ts
type LlmDevelopmentKeyRow = {
  season_id: string
  user_id: string
  key_id: string
  secret_hash: string
  created_at: string
  rotated_at: string | null
}
```

The `(season_id, user_id)` pair is the primary key, and `key_id` has a unique index. A bearer credential uses the format `sk-sandbox-dev-<key_id>.<secret>`, where the public key ID selects one row and only a hash of the cryptographically random secret is stored. Authentication parses the key ID, performs one indexed lookup, and verifies the secret hash in constant time.

`POST /api/seasons/:seasonId/llm-development-key` requires an authenticated `normal` or `admin` user and effective LLM access for the named season. It rotates the pair's key and returns the plaintext once:

```json
{
  "season_id": "season-id",
  "base_url": "https://sandbox.example/api/llm/v1",
  "api_key": "sk-sandbox-dev-<key-id>.<secret>",
  "models": ["small", "medium"],
  "cost_weights": {
    "small": 1,
    "medium": 2
  },
  "limits": {
    "token_budget": 100000,
    "call_budget": 1000,
    "rate_limit_rpm": 30
  }
}
```

The public base URL is derived from `PUBLIC_ORIGIN`. Rotation atomically replaces both the key ID and secret hash, invalidating the previous credential immediately while leaving accumulated development usage unchanged.

Mount the shared Step 1 handler at `POST /api/llm/v1/chat/completions`. Development-key authentication resolves `{kind: 'development', seasonId, userId}` through the indexed key ID lookup and constant-time secret verification. It also checks the participant's current account status and the season's current effective LLM configuration, so a ban, status restriction, disabled season, or unavailable upstream stops authorization without rotating the key.

## Development meter and ledger

Store development calls in `data/llm/development/<seasonId>.sqlite`. The ledger is keyed by season at the file level and by participant within the table:

```sql
CREATE TABLE calls (
  id               INTEGER PRIMARY KEY,
  user_id          TEXT NOT NULL,
  model            TEXT NOT NULL,
  request_json     TEXT NOT NULL,
  completion_json  TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  output_tokens    INTEGER NOT NULL,
  usage_estimated  INTEGER NOT NULL,
  latency_ms       INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX calls_user ON calls (user_id, id);

CREATE TABLE meter_health (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at TEXT NOT NULL
);
```

The development store uses `PRAGMA user_version`, explicit migrations, prepared statements, and the same validated scope-path rules as official telemetry.

The development meter uses `(seasonId, userId)` as one accounting scope for call, weighted-token, and rate limits. It sums successful rows by model for that pair and prices them with the current resolved season values, then combines them with temporary in-flight unweighted-call and weighted-token reservations. Its in-memory sliding rate window is keyed by the same pair. Key rotation does not create a new meter or clear any window.

After authentication, current effective-configuration resolution, request validation, breaker checks, and successful call-and-token reservation, admission reserves one pending slot in that pair's rate window before the first upstream attempt. A successful response converts that slot into one event stamped at the request's start, unless the start has already left the window. A non-retryable upstream error or exhausted retry sequence releases the pending slot and records no event. Backend retries are attempts within the same logical request and reserve no additional slots. Requests rejected locally before upstream admission, including rate, budget, and open-breaker rejections, reserve no slot.

A successful logical request writes one full row and consumes one call using upstream usage when it is valid or the Step 1 fallback estimate otherwise. `usage_estimated` records which source produced the stored token counts so read APIs and user interfaces can identify estimates. Every unsuccessful upstream path releases its call, token, and pending rate reservations and leaves the ledger unchanged.

Post-upstream processing and the ledger transaction complete before the proxy returns a successful development completion. If normalization, usage resolution, or the durable commit fails after the upstream succeeds, the meter moves the conservative call and token reservation into in-memory charged debt for `(seasonId, userId)`, opens that pair's circuit breaker, and returns `503 meter_unavailable` instead of the completion. Requests rejected by the breaker never reach the upstream. The generic single-flight recovery loop from Step 1 probes the season ledger at the configured interval. A committed `meter_health` transaction closes that pair's breaker automatically without discarding debt retained by the running process; a failed probe leaves it open and schedules the next attempt. Conservative debt is process-lifetime state, so a trusted operator restart clears it along with reservations and rate windows. After a restart, a pair can admit requests only after the season ledger opens, applies its `user_version` changes, and passes the same write-health transaction. Recovery failures are logged without bodies or credentials.

Official telemetry files, game results, placements, and leaderboards never read or write the development ledger. Development requests never use execution scope IDs, recording IDs, session IDs, slots, or ticks.

Step 5 adds participant and operator read APIs over this ledger. Ledger retention follows season retention and is independent of recording deletion.

## Internal session network

`SandboxNetwork` supports `'none' | 'llm'`. Effective LLM sessions use `'llm'`; every other session uses `'none'`.

The Docker implementation creates one internal agent network and one routed relay-egress network per session. A long-lived `alpine/socat` relay joins both networks, exposes the alias `llm-proxy` only on the internal network, and forwards one fixed listener to `host.docker.internal:<LLM_INTERNAL_PORT>` through the egress network. The relay alone receives the `host-gateway` mapping used on Linux and Docker Desktop. The session container joins only the internal network, so it has no route to the host or public internet.

Teardown closes grants to admission, aborts or drains active requests, and awaits reservation finalizers before disconnecting the relay and deleting both per-session networks. Driver orphan reaping covers labeled LLM networks and relay attachments. The driver-neutral profile maps to an equivalent single-destination policy in other drivers.

## Tests

Docker-free backend and frontend tests cover:

- The strict season schema, inheritance of every configured alias when models are absent, rejection of empty, duplicate, and unavailable model lists, independent fallback of official and development limits, and admin-editor round trips.
- The effective configuration matrix across deployment, environment, and season inputs.
- Live sessions using the current play-open season, development calls using current effective configuration, and workflow matches using only the fully resolved official policy stored when their run was created.
- One key per agent slot, no key for human slots, live grants using the session scope, workflow grants using the run scope, the exact launch-config shape, and no LLM block for a disabled session.
- Admission closure, active-request abort or drain, and reservation finalization after every launch failure and teardown path, with no write or aggregate query racing the completed barrier.
- Development-key authentication through one indexed key ID lookup and constant-time secret verification, one-time plaintext return, hash persistence, rotation of both identifier and secret, backend restart, account status checks, and season scoping.
- Independent development call, token, and sliding-rate scopes for two users in one season and one user in two seasons, including key rotation preserving every counter and rate event.
- Immediate application of changed season models and limits to an existing development key.
- One successful development request adding one rate event, with non-retryable failures and exhausted retries releasing pending capacity, backend retry attempts adding no capacity, and pre-admission rejections reserving none.
- Successful development calls writing one row with the correct `usage_estimated` value and every rejection or terminal upstream failure writing none.
- A post-upstream development-accounting failure retaining conservative debt, returning `meter_unavailable`, and blocking that participant and season until the automatic recovery loop commits a successful write-health check, without blocking another participant or season.
- Complete isolation between official meters and development meters.
- A fresh application database creates the development-key table and nullable recording associations from the flat initial schema, and live LLM recording registration stores the session scope and session filter IDs.

Docker integration covers:

- A container request succeeds through `llm-proxy`, while a request to the public internet has no route.
- A non-LLM container uses `NetworkMode: none`.
- Teardown blocks the saved slot key, settles active requests and reservations, then removes the network and detaches the relay without a late telemetry write.
- Orphan reaping removes a deliberately abandoned LLM network and attachment.

## Done when

- Deployment, environment, and season inputs resolve current live and development policy, while run creation freezes a complete official model mapping and limit policy used by every workflow match.
- Official sessions receive scoped slot keys, an explicit OpenAI base URL and tick URL, and a single-destination internal network. Every teardown path blocks admission and settles active work before aggregation or deletion.
- An active participant can rotate one indexed key ID and secret for a season and call the public backend proxy with the returned base URL and credential.
- Development call, token, and admitted-request rate usage is metered per participant and season under season-specific limits and remains isolated from every official artifact.
- Successful development calls create full private ledger rows that identify estimated token usage. Unsuccessful calls create no row and consume no call or token budget.
- A post-upstream development-accounting failure returns no completion and opens a pair-scoped circuit breaker until verified storage recovery closes it automatically.
- Docker-free and Docker-gated tests prove the authorization, isolation, lifecycle, and network contracts.
