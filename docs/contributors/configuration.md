# Configuration

Game Sandbox is configured entirely through environment variables. There are no configuration files or secrets manager in this stage. Most settings have class-scale defaults, while capabilities that require deployment credentials or external endpoints remain disabled until their required values are configured.

This page is the full reference for those variables. Read [Backend](backend.md) for how the values are consumed, and [Development setup](development-setup.md) to get a working local environment first.

## How configuration loads

`config.ts` reads environment variables once, at startup, into a single typed `Config` object through `loadConfig()`. Services receive `Config`, or the slice they need, through their constructor. Reading process environment variables from feature modules is banned, so a test can assemble a whole backend with custom settings.

## Validation

Dedicated parsers and Zod schemas validate every value, so a malformed setting fails fast at startup with a message naming the offending variable instead of surfacing later as a confusing runtime error. The accepted forms are:

- Integer settings must be whole numbers. Quotas may allow zero, while ports and timing intervals use setting-specific positive upper and lower bounds. Floats, `NaN`, negatives, and out-of-range values are rejected.
- Quotas that allow fractions, such as `SANDBOX_CPUS`, must be positive finite numbers.
- Booleans accept `true`, `1`, or `yes` for true, and `false`, `0`, or `no` for false.
- Comma-separated lists, such as `AUTH_TRUSTED_ORIGINS`, are trimmed and drop blank entries.
- `LLM_UPSTREAM_URL` must be an absolute `http` or `https` base URL with no surrounding whitespace, embedded credentials, query, or fragment. An invalid value is rejected without copying the value into the error message.

## Server and session

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP and WebSocket port |
| `SITE_NAME` | `Game Sandbox` | Display name used for branding, such as page titles and the sidebar brand |
| `SITE_SHORT_NAME` | value of `SITE_NAME` | Compact brand for space-sensitive contexts, such as the mobile bar; falls back to `SITE_NAME` |
| `DATA_DIR` | `./data` | Root containing `sandbox.db` and recording directories |
| `SESSION_IDLE_TIMEOUT_MS` | `60000` | Lifetime with no attached socket, or no human command in human mode |
| `SESSION_MAX_DURATION_MS` | `600000` | Wall-clock backstop |
| `SANDBOX_CPUS` | `1` | Session CPU quota |
| `SANDBOX_MEMORY_MB` | `512` | Session memory quota |
| `SANDBOX_SCRATCH_MB` | `256` | Writable scratch quota |

## Authentication

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTH_SECRET` | `dev-secret-do-not-deploy-32-chars` | Better Auth signing secret for cookies and tokens. The development value meets the length minimum but is public and accepted only with the explicit insecure-defaults opt-in on a loopback origin. |
| `PUBLIC_ORIGIN` | `http://localhost:<PORT>` in insecure development only | The public origin the site is reached at, for cookie origin checks and OAuth callbacks. A normal startup requires it explicitly. The GitHub callback URL is `<PUBLIC_ORIGIN>/api/auth/callback/github`. |
| `AUTH_TRUSTED_ORIGINS` | unset | Extra comma-separated origins appended to the built-in list, which is `PUBLIC_ORIGIN` plus these (and `http://localhost:5173` only under the loopback insecure-defaults opt-in). |
| `AUTH_ALLOW_INSECURE_DEFAULTS` | `false` | Allows the published development secret and bootstrap credentials, but only with a loopback `PUBLIC_ORIGIN`. Never enable it in a deployment. |
| `ADMIN_EMAIL` | `admin@example.com` | Bootstrap admin's development email. Accepted only with the insecure-defaults opt-in on a loopback origin; a deployment must set it explicitly. |
| `ADMIN_PASSWORD` | `admin-dev-password` | Bootstrap admin's development password, re-synced on every boot. Accepted only with the insecure-defaults opt-in on a loopback origin; a deployment must set it explicitly. |
| `ADMIN_NAME` | `Admin` | Seeded admin's display name. |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | unset | GitHub OAuth app credentials. Both or neither: setting exactly one is a `ConfigError`. Distinct from `GITHUB_TOKEN`, which stays a submissions-only credential. |

## Execution and frontend

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXECUTION_DRIVER` | `docker` | Active driver |
| `DOCKER_IMAGE_TAG_PREFIX` | `game-sandbox` | Image prefix |
| `DOCKER_IMAGE_POLICY` | `reuse` | `reuse` an existing tag or `rebuild` before launch |
| `FRONTEND_DIST` | `frontend/dist` | Built frontend directory; static serving is disabled when absent |
| `DOCS_DIR` | `docs` | Documentation root the in-app student guides are read from; only its `students/` subtree is served |
| `DOCS_INDEX_FILE` | unset | Optional markdown file that replaces the documentation landing page; unset serves `docs/students/index.md` |

## Recordings

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECORDING_RETENTION_DAYS` | `30` | Age limit for unpinned recordings |
| `RECORDING_USER_QUOTA` | `100` | Per-user recording count; pinned recordings count but are not evicted |
| `RECORDING_SWEEP_INTERVAL_MS` | `3600000` | Periodic sweep interval; sweeps also run at startup and finalization |

## LLM proxy

The internal OpenAI-compatible proxy starts only when `LLM_UPSTREAM_URL` and at least one model alias are configured. Agents use the stable aliases `large`, `medium`, and `small`; the matching `LLM_MODEL_*` values and the optional upstream credential stay inside the backend. `LLM_INTERNAL_PORT` binds on all interfaces so the per-session Docker relay added by Stage 9 can reach it through the host gateway. The listener requires a scoped bearer key on every route.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_INTERNAL_PORT` | `8081` | Internal proxy port reached by the session relay; must be from 1 through 65535 |
| `LLM_UPSTREAM_URL` | unset | Absolute `http` or `https` base URL of the one configured OpenAI-compatible upstream, without credentials, query, or fragment; the proxy remains off when unset |
| `LLM_UPSTREAM_KEY` | unset | Optional upstream bearer credential; requests omit authorization when it is unset |
| `LLM_MODEL_LARGE` | unset | Upstream model exposed to agents as `large` |
| `LLM_MODEL_MEDIUM` | unset | Upstream model exposed to agents as `medium` |
| `LLM_MODEL_SMALL` | unset | Upstream model exposed to agents as `small` |
| `LLM_UPSTREAM_TIMEOUT_MS` | `30000` | Per-attempt timeout, bounded from 1 through 600000 milliseconds |
| `LLM_UPSTREAM_MAX_RETRIES` | `2` | Retry attempts after the initial attempt, bounded from 0 through 10 |
| `LLM_UPSTREAM_RETRY_INTERVAL_MS` | `250` | Initial exponential-backoff interval, bounded from 1 through 60000 milliseconds |
| `LLM_TIKTOKEN_ENCODING` | `cl100k_base` | Tiktoken encoding used over canonical JSON for admission and fallback estimates; participant strings are always ordinary content, including text resembling special tokens |
| `LLM_DEFAULT_MAX_OUTPUT_TOKENS` | `1024` | Enforced output maximum when a request supplies neither supported maximum field |
| `LLM_MAX_OUTPUT_TOKENS` | `4096` | Hard ceiling for explicit and default output maxima, bounded from 1 through 1000000 |
| `LLM_METER_RECOVERY_INTERVAL_MS` | `5000` | Delay between write-health probes for an open accounting breaker, bounded from 1 through 3600000 milliseconds |
| `LLM_SESSION_TOKEN_BUDGET` | `100000` | Successful input-plus-completion token allowance per official session slot |
| `LLM_SESSION_CALL_BUDGET` | `100` | Successful-call allowance per official session slot |
| `LLM_SESSION_RATE_LIMIT_RPM` | `60` | Admitted logical requests per minute per official session slot |
| `LLM_RUN_TOKEN_BUDGET` | `1000000` | Successful input-plus-completion token allowance per submission in a run |
| `LLM_RUN_CALL_BUDGET` | `1000` | Successful-call allowance per submission in a run |
| `LLM_RUN_RATE_LIMIT_RPM` | `60` | Admitted logical requests per minute per submission in a run |

`LLM_DEFAULT_MAX_OUTPUT_TOKENS` may be zero but must not exceed `LLM_MAX_OUTPUT_TOKENS`. Token budgets count input plus total completion tokens. Reasoning tokens are reported separately as a subset of completion usage and are not charged twice.

## Submissions

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITHUB_TOKEN` | unset | Optional private-repository and reachability token; never stored with a submission |
| `ALLOW_LOCAL_SUBMISSIONS` | `false` | Enable the trusted development-only local source |
| `SUBMISSION_GIT_TIMEOUT_MS` | `15000` | Git operation deadline |
| `SUBMISSION_BUILD_TIMEOUT_MS` | `120000` | Overlay build deadline |
| `SUBMISSION_LOAD_CHECK_TIMEOUT_MS` | `30000` | Sandboxed load-check deadline |
| `SUBMISSION_MAX_SIZE_MB` | `25` | Maximum checked-out submission source size, in MB, measured without `.git`/VCS history; a per-season `overrides.submission_max_size_mb` takes precedence. `0` rejects every submission |
| `OVERLAY_IMAGE_BUDGET` | `50` | Maximum cached submission overlays; active ready images are protected and count |
| `OVERLAY_IMAGE_SWEEP_INTERVAL_MS` | `3600000` | Overlay sweep interval; sweeps also run at startup and after builds |

`DATA_DIR` also roots the submission-snapshot volume (`<DATA_DIR>/submissions`): one `.tar.gz` per accepted submission, bounded on disk by `SUBMISSION_MAX_SIZE_MB` times the number of retained submissions. See [Backend](backend.md).

## Deployment notes

Keep `ALLOW_LOCAL_SUBMISSIONS` disabled in real deployments. The gate, not path sanitization, is its security boundary.

`GITHUB_TOKEN` authenticates private-repository access and reachability checks only. It is never stored on a submission row or written to logs.

Static frontend serving is wired only when `FRONTEND_DIST` points at an existing directory, so Vite development and tests without a built bundle are unaffected. See [Static frontend](backend.md#static-frontend).

The Documentation page reads the student guides from `DOCS_DIR` at request time, so a guide updates without a frontend rebuild. Set `DOCS_INDEX_FILE` to give a class its own landing page, such as a schedule or grading notes, without editing the shared guides; a configured file that cannot be read fails the landing request loudly rather than silently falling back.

Set `AUTH_SECRET` and the bootstrap `ADMIN_EMAIL`/`ADMIN_PASSWORD` explicitly. A normal startup refuses to run without an explicit `PUBLIC_ORIGIN`, signing secret, and bootstrap credentials, so there is no accidental fallback to the published development values. Never enable `AUTH_ALLOW_INSECURE_DEFAULTS` outside loopback development; besides accepting those published values, it also restricts the HTTP listener to loopback. When GitHub OAuth is configured, register the callback URL `<PUBLIC_ORIGIN>/api/auth/callback/github` with the OAuth app. `GITHUB_TOKEN` stays a submissions-only credential, distinct from the OAuth app's client ID and secret. `sandbox.db` now also holds the Better Auth tables (`user`, `session`, `account`, `verification`), created by a separate programmatic migration rather than the app's own schema.

## See also

- [Backend](backend.md) builds `Config` and distributes it to services.
- [Execution boundary](execution.md) applies the sandbox quotas to every session container.
- [Development setup](development-setup.md) gets a local environment running on the defaults.
