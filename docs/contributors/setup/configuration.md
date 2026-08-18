# Configuration

Game Sandbox uses environment variables for configuration. The tracked `.env.default` file at the repository root defines the runtime defaults. Features that need private credentials or external endpoints remain disabled until configured.

This page is the full reference for those variables. Read [Backend](../runtime/backend.md) for how the values are consumed, and [Development setup](development.md) to get a working local environment first.

## How configuration loads

`loadConfig()` reads configuration once at startup. From the repository root, it loads the required `.env.default` and then an optional `.env`. Variables from the parent process override both files, so the precedence is the process environment, then `.env`, then `.env.default`. Setting `LOAD_LOCAL_ENV=false` in the process environment skips the `.env` file entirely, which a launcher uses when it must boot a backend immune to a machine-local `.env` (the browser e2e suite). The file paths and relative values for `DATA_DIR`, `FRONTEND_DIST`, `DOCS_DIR`, and `DOCS_INDEX_FILE` are resolved from the repository root, so startup does not depend on the current working directory. See [Data folders](../data/folders.md) to locate the active `DATA_DIR`.

Edit `.env.default` when a tracked default changes. It contains public development credentials that are safe only because insecure development mode binds the backend to loopback. Never put private credentials in this file: use the Git-ignored `.env` for those and for machine-specific values. Other `.env.*` files are not loaded automatically.

After loading, `backend/src/config/config.ts` validates required values and parses the environment into one typed `Config` object. It also derives values such as `SITE_SHORT_NAME`, which falls back to `SITE_NAME` when unset. Feature modules receive configuration rather than reading process environment variables directly.

## Validation

Dedicated parsers and Zod schemas validate every value. A missing or malformed setting fails at startup with a message that names the variable. The accepted forms are:

- Integer settings must be non-negative whole numbers unless the variable reference states stricter bounds. Floats, `NaN`, negatives, and values outside stated bounds are rejected.
- Quotas that allow fractions, such as `SANDBOX_CPUS`, must be positive finite numbers.
- Booleans accept `true`, `1`, or `yes` for true, and `false`, `0`, or `no` for false.
- Comma-separated lists, such as `AUTH_TRUSTED_ORIGINS`, are trimmed and drop blank entries.
- `LLM_UPSTREAM_URL` must be an absolute `http` or `https` base URL with no surrounding whitespace, embedded credentials, query, or fragment. An invalid value is rejected without copying it into the error message.

## Server and session

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP and WebSocket port |
| `SITE_NAME` | `Game Sandbox` | Display name used for branding, such as page titles and the sidebar brand |
| `SITE_SHORT_NAME` | value of `SITE_NAME` | Compact brand for space-sensitive contexts, such as the mobile bar; falls back to `SITE_NAME` |
| `DATA_DIR` | `backend/data` | Repository-relative runtime-data root. Container deployments need identical absolute host and Compose `app` container paths; see [Run the app in Docker](docker.md) and [Data folders](../data/folders.md). |
| `LOAD_LOCAL_ENV` | `true` | Whether the machine-local Git-ignored `.env` is loaded. `false` skips it entirely, so a launcher (such as the browser e2e suite) can boot immune to a deployment's `.env` left in the tree. |
| `SESSION_IDLE_TIMEOUT_MS` | `60000` | Lifetime with no viewer in scripted mode, or no owner socket in human mode |
| `SESSION_MAX_DURATION_MS` | unset | Optional positive chargeable-duration override. When unset, each session derives its limit from its pace and episode rules. |
| `SANDBOX_CPUS` | `1` | Session CPU quota |
| `SANDBOX_MEMORY_MB` | `512` | Base session memory quota |
| `SANDBOX_MEMORY_PER_PLAYER_MB` | `32` | Additional memory quota for each player after the first |
| `SANDBOX_SCRATCH_MB` | `256` | Writable scratch quota |

`LOCAL_HTTPS_PORT` is a Docker setup and Compose value, not a backend listener. It defaults to `8443`, cannot use the public HTTPS port `443`, and publishes the proxy's local HTTPS listener on `127.0.0.1` only. [Run the app in Docker](docker.md) describes the two proxy listeners.

## Authentication

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTH_SECRET` | `dev-secret-do-not-deploy-32-chars` | Better Auth signing secret for cookies and tokens. |
| `PUBLIC_ORIGIN` | `http://localhost:8080` | The public origin the site is reached at, for cookie origin checks and OAuth callbacks. Override it together with `PORT` when changing the local port. |
| `AUTH_TRUSTED_ORIGINS` | unset | Extra comma-separated origins appended to the built-in list, which is `PUBLIC_ORIGIN` plus these (and, only under the loopback insecure-defaults opt-in, every loopback spelling of the configured origin's port, `localhost`, `127.0.0.1`, `[::1]`, plus `http://localhost:5173`). |
| `AUTH_ALLOW_INSECURE_DEFAULTS` | `true` | Allows the published development secret and bootstrap credentials, but only with a loopback `PUBLIC_ORIGIN`. |
| `ADMIN_EMAIL` | `admin@example.com` | Bootstrap admin's development email. |
| `ADMIN_PASSWORD` | `admin-dev-password` | Bootstrap admin's development password, re-synced on every boot. |
| `ADMIN_NAME` | `Admin` | Seeded admin's display name. |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | unset | GitHub OAuth app credentials. Both or neither: setting exactly one is a `ConfigError`. The same OAuth app powers sign-in and profile account linking. |

## Execution and frontend

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXECUTION_DRIVER` | `docker` | Active driver |
| `DOCKER_IMAGE_TAG_PREFIX` | `game-sandbox` | Image prefix |
| `DOCKER_IMAGE_POLICY` | `reuse` | `reuse` an existing tag or `rebuild` before launch |
| `DOCKER_LLM_RELAY_MODE` | `host-gateway` | `host-gateway` reaches a host-process backend through `host.docker.internal`; `compose-network` joins an existing named network and reaches a service hostname |
| `DOCKER_LLM_RELAY_NETWORK` | unset | Existing Docker network used by the relay in `compose-network` mode; required in that mode and forbidden in `host-gateway` mode |
| `DOCKER_LLM_RELAY_HOST` | unset | Backend DNS hostname used by the relay in `compose-network` mode; required in that mode and forbidden in `host-gateway` mode |
| `FRONTEND_DIST` | `frontend/dist` | Built frontend directory; static serving is disabled when absent |
| `GOOGLE_ANALYTICS_ID` | unset | Optional Google Analytics 4 measurement ID, such as `G-G98YR1FFWX`. When set, the served `index.html` carries the gtag.js loader, so it is applied at startup with no frontend rebuild; unset leaves the bundle untouched |
| `DOCS_DIR` | `docs` | Documentation root for shared in-app student guides; only its `students/` subtree is served |
| `DOCS_INDEX_FILE` | unset | Optional markdown file that replaces the documentation landing page; unset serves `docs/students/index.md` |
| `TEMPLATE_REPO_URL` | `https://github.com/vox-deorum/game-agent-template` | Published student template repository used when a season has no repository URL. When this fallback is used, the setup dialog selects its `templates/<environment>` branch. A season-specific URL uses its default branch. |

## Recordings

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECORDING_RETENTION_DAYS` | `30` | Age limit for unpinned recordings |
| `RECORDING_USER_QUOTA` | `100` | Per-user recording count; pinned recordings count but are not evicted |
| `RECORDING_SWEEP_INTERVAL_MS` | `3600000` | Periodic sweep interval; sweeps also run at startup and finalization |

## LLM proxy

The internal OpenAI-compatible proxy starts only when `LLM_UPSTREAM_URL` and at least one model tier are configured. Agents use the stable tiers `large`, `medium`, and `small`; matching `LLM_MODEL_*` variables map these tiers to private upstream models. The optional upstream credential also stays inside the backend. Development-key responses include the resolved tier prices. Every listener route requires a scoped bearer key.

The listener binds on all interfaces inside the Compose `app` container so the fixed-destination relay can reach it. Host-process deployments use `host-gateway` mode. The Compose deployment selects `compose-network`, attaches the relay to `game-sandbox-internal`, and reaches the Compose `app` container without publishing `LLM_INTERNAL_PORT` on the host. The sandbox agent cannot join or resolve that shared network.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_INTERNAL_PORT` | `8081` | Internal proxy port reached only by the fixed-destination session relay; must be from 1 through 65535 |
| `LLM_UPSTREAM_URL` | unset | Absolute `http` or `https` base URL of the one configured OpenAI-compatible upstream, without credentials, query, or fragment; the proxy remains off when unset |
| `LLM_UPSTREAM_KEY` | unset | Optional upstream bearer credential; requests omit authorization when it is unset |
| `LLM_MODEL_LARGE` | unset | Upstream model exposed to agents as `large` |
| `LLM_MODEL_MEDIUM` | unset | Upstream model exposed to agents as `medium` |
| `LLM_MODEL_SMALL` | unset | Upstream model exposed to agents as `small` |
| `LLM_COST_WEIGHT_LARGE` | `4` | Budget units consumed by each input or completion token from the `large` tier; positive and at most 1000000 |
| `LLM_COST_WEIGHT_MEDIUM` | `2` | Budget units consumed by each input or completion token from the `medium` tier; positive and at most 1000000 |
| `LLM_COST_WEIGHT_SMALL` | `1` | Budget units consumed by each input or completion token from the `small` tier; positive and at most 1000000 |
| `LLM_UPSTREAM_TIMEOUT_MS` | `30000` | Per-attempt timeout, bounded from 1 through 600000 milliseconds |
| `LLM_UPSTREAM_MAX_RETRIES` | `2` | Retry attempts after the initial attempt, bounded from 0 through 10 |
| `LLM_TIKTOKEN_ENCODING` | `cl100k_base` | Tiktoken encoding used over canonical JSON for admission and fallback estimates; participant strings are always ordinary content, including text resembling special tokens |
| `LLM_DEFAULT_MAX_OUTPUT_TOKENS` | `1024` | Enforced output maximum when a request supplies neither supported maximum field |
| `LLM_MAX_OUTPUT_TOKENS` | `4096` | Hard ceiling for explicit and default output maxima, bounded from 1 through 1000000 |
| `LLM_SESSION_TOKEN_BUDGET` | `100000` | Successful weighted-token allowance per official session player |
| `LLM_SESSION_RATE_LIMIT_RPM` | `60` | Successful logical requests per minute per official session player; an in-flight request reserves window capacity until it resolves or its start leaves the window |
| `LLM_DEVELOPMENT_TOKEN_BUDGET` | `100000` | Successful weighted-token allowance per participant and season |
| `LLM_DEVELOPMENT_RATE_LIMIT_RPM` | `30` | Successful logical requests per minute per participant and season |

`LLM_DEFAULT_MAX_OUTPUT_TOKENS` may be zero but must not exceed `LLM_MAX_OUTPUT_TOKENS`. [Budgets and limits](../../specs/llm.md#budgets-and-limits) defines how weighted-token budgets are counted and priced.

## Submissions

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITHUB_TOKEN` | unset | Optional private-repository and reachability token; never stored with a submission |
| `ALLOW_LOCAL_SUBMISSIONS` | `false` | Enable the trusted development-only local source |
| `SUBMISSION_GIT_TIMEOUT_MS` | `15000` | Git operation deadline |
| `SUBMISSION_BUILD_TIMEOUT_MS` | `120000` | Overlay build deadline |
| `SUBMISSION_LOAD_CHECK_TIMEOUT_MS` | `30000` | Sandboxed load-check deadline |
| `SUBMISSION_MAX_SIZE_MB` | `25` | Maximum checked-out submission source size, in MB, measured after dropping VCS history, dependency and virtual-environment directories, tool caches, compiled bytecode, and build or dist output; a submission's own `data/` directory counts. A per-season `overrides.submission_max_size_mb` takes precedence. `0` rejects every submission |
| `OVERLAY_IMAGE_BUDGET` | `50` | Maximum cached submission overlays; active ready images are protected and count |
| `OVERLAY_IMAGE_SWEEP_INTERVAL_MS` | `3600000` | Overlay sweep interval; sweeps also run at startup and after builds |

`DATA_DIR` also contains the submission snapshot directory at `<DATA_DIR>/submissions`, one `.tar.gz` file per accepted submission; [Snapshots and downloads](../../specs/submission.md#snapshots-and-downloads) states the storage bound. See [Data folders](../data/folders.md) for locations and [Backend](../runtime/backend.md) for the pipeline.

## Deployment notes

To run the whole app in a container on a Linux daemon, see [Run the app in Docker](docker.md); every rule below applies there too.

Keep `ALLOW_LOCAL_SUBMISSIONS` disabled in real deployments. The gate, not path sanitization, is its security boundary.

`GITHUB_TOKEN` authenticates private-repository access and reachability checks only. It is never stored on a submission row or written to logs.

Static frontend serving is wired only when `FRONTEND_DIST` points at an existing directory, so Vite development and tests without a built bundle are unaffected. See [Static frontend](../runtime/backend.md#static-frontend).

The Documentation page follows these rules:

- Reads shared guides from `DOCS_DIR` and discovers game guides from `environments/<env>/environment.md` at request time, so updating a guide needs no frontend rebuild.
- Serves game guides at virtual `students/environments/<slug>.md` paths, with no mirror under `DOCS_DIR`.
- Uses `DOCS_INDEX_FILE`, when set, as a class-specific landing page (a schedule or grading notes, for example) in place of the default, without editing the shared guides.
- Fails the landing request, rather than falling back to the default page, when the configured `DOCS_INDEX_FILE` cannot be read.

A deployment must:

- Set `PUBLIC_ORIGIN`, `AUTH_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` explicitly. Startup refuses the published development values for `AUTH_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
- Change `PUBLIC_ORIGIN` from its development default: startup only validates it as a well-formed origin and does not check it against the development value.
- For Docker deployment, use an exact HTTPS ASCII FQDN with no port, path, trailing slash, or trailing dot. The setup wizard and proxy reject other forms because the hostname defines the TLS certificate and nginx virtual host.
- Register `<PUBLIC_ORIGIN>/api/auth/callback/github` as the GitHub OAuth callback URL, when GitHub OAuth is configured.
- Keep `GITHUB_TOKEN` separate from the GitHub OAuth client credentials; it is used only for submissions.
- Never enable `AUTH_ALLOW_INSECURE_DEFAULTS`. A deployment from a repository checkout must set it to `false` explicitly to override the local `.env.default`; in local mode it accepts the published values and restricts the HTTP listener to loopback.

`sandbox.db` also contains the Better Auth tables (`user`, `session`, `account`, `verification`), which a separate programmatic migration creates outside the application's schema.

## See also

- [Backend](../runtime/backend.md) builds `Config` and distributes it to services.
- [Execution boundary](../runtime/execution.md) applies the sandbox quotas to every session container.
- [Development setup](development.md) gets a local environment running on the defaults.
