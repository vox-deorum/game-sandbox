# Configuration

Game Sandbox is configured entirely through environment variables. There are no configuration files and no secrets manager in this stage, and every setting has a class-scale default, so the backend, the admin console, and the demo all run out of the box without setting anything.

This page is the full reference for those variables. Read [Backend](backend.md) for how the values are consumed, and [Development setup](development-setup.md) to get a working local environment first.

## How configuration loads

`config.ts` reads environment variables once, at startup, into a single typed `Config` object through `loadConfig()`. Services receive `Config`, or the slice they need, through their constructor. Reading process environment variables from feature modules is banned, so a test can assemble a whole backend with custom settings.

## Validation

Zod validates every value, so a malformed setting fails fast at startup with a message naming the offending variable instead of surfacing later as a confusing runtime error. The accepted forms are:

- Integer settings must be non-negative whole numbers. Floats, `NaN`, and negatives are rejected.
- Quotas that allow fractions, such as `SANDBOX_CPUS`, must be positive finite numbers.
- Booleans accept `true`, `1`, or `yes` for true, and `false`, `0`, or `no` for false.
- Allowlists are comma-separated. Entries are trimmed and blank entries are dropped.

## Server and session

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP and WebSocket port |
| `SITE_NAME` | `Game Sandbox` | Display name used for branding, such as page titles and the sidebar brand |
| `SITE_SHORT_NAME` | value of `SITE_NAME` | Compact brand for space-sensitive contexts, such as the mobile bar; falls back to `SITE_NAME` |
| `DATA_DIR` | `./data` | Root containing `sandbox.db` and recording directories |
| `SESSION_IDLE_TIMEOUT_MS` | `60000` | Lifetime with no attached socket, or no human command in human mode |
| `SESSION_MAX_DURATION_MS` | `600000` | Wall-clock backstop |
| `SESSION_ALLOWLIST` | `dev-user` | Comma-separated users allowed to start sessions; empty allows no one |
| `OPERATOR_ALLOWLIST` | `dev-user` | Comma-separated users allowed to use `/api/admin` |
| `SANDBOX_CPUS` | `1` | Session CPU quota |
| `SANDBOX_MEMORY_MB` | `512` | Session memory quota |
| `SANDBOX_SCRATCH_MB` | `256` | Writable scratch quota |

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

The allowlists default to `dev-user` so the stack works in development. An empty `SESSION_ALLOWLIST` allows no one to start sessions, while read-only routes and spectating stay open. `OPERATOR_ALLOWLIST` guards every `/api/admin` route through one operator check.

## See also

- [Backend](backend.md) builds `Config` and distributes it to services.
- [Execution boundary](execution.md) applies the sandbox quotas to every session container.
- [Development setup](development-setup.md) gets a local environment running on the defaults.
