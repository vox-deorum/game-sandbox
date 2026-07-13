# Stage 9.2: Season Access, Development Keys, and the Session Network

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 2.

## Outcome

Environment metadata and season configuration resolve the allowed model aliases and separate official and development limits. Official launches receive temporary slot keys and an isolated route to the backend proxy. Active participants can request a durable development key scoped to one season and use a private per-participant meter and ledger.

The hands-on check obtains a student key for one season, makes a successful local request, and confirms that another participant and season have independent usage. A session container reaches the backend proxy and cannot reach the public internet. Its slot key stops authorizing at teardown.

## Effective LLM configuration

`EnvironmentMeta.llm` remains the environment capability flag. `resolveLlm(deployment, environment, season)` enables LLM access only when all three conditions hold:

1. The deployment configures an upstream and at least one model alias.
2. The environment sets `llm: true`.
3. The season sets `llm.enabled: true`.

The season model list must be a non-empty subset of the deployment's configured aliases. Live sessions resolve the play-open season. Workflow matches resolve the run's frozen `config_snapshot`. Development keys resolve their named season on every request. Submission, play, and release gates do not change development-key validity; the season's LLM configuration is the authority.

Persist the resolved official flag on the session row as `llm_enabled`. Session payloads and recording views read that stored value after execution.

Add nullable `llm_scope_id` and `llm_session_id` columns to the backend recordings table and its creation input. A live LLM recording stores its session ID in both columns. Recordings without official LLM telemetry store null, and existing rows migrate as null. These durable fields remain available when session or workflow rows are pruned.

## Season schema and admin editor

Define a strict `LlmOverrideSchema` in `backend/src/storage/season-config.ts`:

```ts
llm?: {
  enabled?: boolean
  models?: Array<'large' | 'medium' | 'small'>
  official?: {
    session_token_budget?: number
    session_call_budget?: number
    session_rate_limit_rpm?: number
    run_token_budget?: number
    run_call_budget?: number
    run_rate_limit_rpm?: number
  }
  development?: {
    token_budget?: number
    call_budget?: number
    rate_limit_rpm?: number
  }
}
```

Unset values inherit deployment defaults. Official and development blocks resolve independently. Admin season updates reject unknown fields, non-positive limits, duplicate model aliases, and aliases unavailable on the deployment.

`SeasonConfigEditor.vue` exposes enablement, allowed aliases, official session and run limits, and development limits as separate field groups built from existing UI primitives. The styleguide and admin-editor unit tests cover every new control and validation state.

Add deployment defaults `LLM_DEVELOPMENT_TOKEN_BUDGET`, `LLM_DEVELOPMENT_CALL_BUDGET`, and `LLM_DEVELOPMENT_RATE_LIMIT_RPM`.

## Official slot keys and launch config

The orchestrator and workflow runner issue one official key for every agent slot when effective LLM access is enabled. Human slots receive no key. Each grant includes telemetry scope, session, slot, allowed models, resolved session limits, and optional run subject and limits. Live grants use the session ID as their scope. Workflow grants use the run ID.

`backend/src/session/launch-config.ts` emits:

```json
{
  "llm": {
    "base_url": "http://llm-proxy:<port>/v1",
    "keys": {
      "player_0": "sk-sandbox-..."
    }
  }
}
```

The session and workflow launch paths share this shape. Step 3 adds the matching harness parser.

Key issuance is enclosed by a teardown owner. Image, network, configuration, and driver-launch failures revoke issued keys before returning. Normal exit, crash exit, explicit stop, live-session finalization, and workflow-game completion call idempotent `revokeSession`. Step 5 owns telemetry file cleanup for scopes that produce no recording and for retained recordings that are deleted later.

## Student development key API

Add a persistent `llm_development_keys` table to the application database:

```ts
type LlmDevelopmentKeyRow = {
  season_id: string
  user_id: string
  secret_hash: string
  created_at: string
  rotated_at: string | null
}
```

The `(season_id, user_id)` pair is the primary key. Only a hash of the secret is stored. Development secrets use an `sk-sandbox-dev-` prefix and sufficient cryptographic randomness.

`POST /api/seasons/:seasonId/llm-development-key` requires an authenticated `normal` or `admin` user and effective LLM access for the named season. It rotates the pair's key and returns the plaintext once:

```json
{
  "season_id": "season-id",
  "base_url": "https://sandbox.example/api/llm/v1",
  "api_key": "sk-sandbox-dev-...",
  "models": ["small", "medium"],
  "limits": {
    "token_budget": 100000,
    "call_budget": 1000,
    "rate_limit_rpm": 30
  }
}
```

The public base URL is derived from `PUBLIC_ORIGIN`. Rotation invalidates the previous secret immediately and leaves accumulated development usage unchanged.

Mount the shared Step 1 handler at `POST /api/llm/v1/chat/completions`. Development-key authentication resolves `{kind: 'development', seasonId, userId}` from the stored hash. It also checks the participant's current account status and the season's current effective LLM configuration, so a ban, status restriction, disabled season, or unavailable upstream stops authorization without rotating the key.

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
  latency_ms       INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX calls_user ON calls (user_id, id);
```

The development store uses `PRAGMA user_version`, explicit migrations, prepared statements, and the same validated scope-path rules as official telemetry.

The development meter sums successful rows for `(seasonId, userId)` and combines them with temporary in-flight reservations. A successful logical request writes one full row and consumes one call using actual upstream usage. Every unsuccessful path releases its reservation and leaves the ledger unchanged.

Official telemetry files, game results, placements, and leaderboards never read or write the development ledger. Development requests never use execution scope IDs, recording IDs, session IDs, slots, ticks, or run subjects.

Step 5 adds participant and operator read APIs over this ledger. Ledger retention follows season retention and is independent of recording deletion.

## Internal session network

`SandboxNetwork` supports `'none' | 'llm'`. Effective LLM sessions use `'llm'`; every other session uses `'none'`.

The Docker implementation creates one internal network per session. A long-lived `alpine/socat` relay joins that network under the alias `llm-proxy` and forwards only to `host.docker.internal:<LLM_INTERNAL_PORT>`. The relay uses `host-gateway` mapping on Linux and Docker Desktop. The session container joins only its internal network.

Teardown disconnects the relay and deletes the per-session network. Driver orphan reaping covers labeled LLM networks and relay attachments. The driver-neutral profile maps to an equivalent single-destination policy in other drivers.

## Tests

Docker-free backend and frontend tests cover:

- The strict season schema, independent fallback of official and development limits, alias validation, and admin-editor round trips.
- The effective configuration matrix across deployment, environment, and season inputs.
- Live sessions using the play-open season and workflow matches using the frozen run configuration.
- One key per agent slot, no key for human slots, live grants using the session scope, workflow grants using the run scope, the exact launch-config shape, and no LLM block for a disabled session.
- Revocation after every launch failure and teardown path.
- Development-key authentication, one-time plaintext return, hash persistence, rotation, backend restart, account status checks, and season scoping.
- Independent development totals for two users in one season and one user in two seasons.
- Immediate application of changed season models and limits to an existing development key.
- Successful development calls writing one row and every rejection or terminal upstream failure writing none.
- Complete isolation between official meters and development meters.
- Recording migrations preserve null associations for existing rows, and live LLM recording registration stores the session scope and session filter IDs.

Docker integration covers:

- A container request succeeds through `llm-proxy`, while a request to the public internet has no route.
- A non-LLM container uses `NetworkMode: none`.
- Teardown revokes the saved slot key, removes the network, and detaches the relay.
- Orphan reaping removes a deliberately abandoned LLM network and attachment.

## Done when

- Deployment, environment, and season inputs resolve one effective model and limit configuration for both launch paths.
- Official sessions receive scoped slot keys and a single-destination internal network, and every teardown path revokes those keys.
- An active participant can rotate one key for a season and call the public backend proxy with the returned base URL and secret.
- Development usage is metered per participant and season under season-specific limits and remains isolated from every official artifact.
- Successful development calls create full private ledger rows. Unsuccessful calls create no row and consume no call or token budget.
- Docker-free and Docker-gated tests prove the authorization, isolation, lifecycle, and network contracts.
