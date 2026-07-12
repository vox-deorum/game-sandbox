# Stage 9.2: Season Enablement, Slot Keys, and the Internal Network

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 2: the orchestration half of the gateway. Step 1's gateway meters whoever holds a key; this step decides who gets keys and how a container reaches the gateway at all. By owner decision, enablement is **season-controlled only**: the inert `overrides.llm` block from Stage 6 becomes a strict codec whose `enabled` defaults to false, the play-open season's override governs live sessions exactly as the Stage 8 messaging override does, and the never-consumed `EnvironmentMeta.llm` flag is removed rather than kept as a third voter.

**Hands-on result:** `docker exec` into an LLM-enabled session, curl the gateway and get an answer, curl the open internet and get nothing, then watch the session's key stop authorizing the moment the container exits.

## Why this is its own seam

- Key issuance, revocation, and the network profile are one correctness story: a slot key is only meaningful if the container can reach the gateway, and the gateway-only network is only safe if the keys it carries die with the session.
- All of it is backend orchestration — testable with a fake driver Docker-free, plus one Docker-gated lane for the real network posture.
- Landing it before the harness work means step 3 changes only Python: by the time the harness sets `OPENAI_API_KEY`, the key already exists, already reaches a live gateway, and already dies on exit.

## What to build

### Remove the environment flag

`EnvironmentMeta.llm` was scaffolded ahead of this stage and never consumed; season-only control makes it dead weight. Remove it everywhere in one change:

- The field and its `to_json` line in `harness/src/game_sandbox_harness/environment.py`; the `llm=False` arguments in all three `environments/src/*/__init__.py` entries.
- The field in `schema/ts/src/environment.ts` and its `isEnvironmentMeta` check; the regenerated `backend/src/generated/environments.json`; any test pinning it.
- Spec and plan move together per the [plans README](../README.md): [llm.md](../../docs/specs/llm.md)'s "may be disabled by the environment or season" becomes "enabled per season, on deployments that configure a provider"; the Stage 2 [environments-and-metadata](../stage-02/environments-and-metadata.md) subplan and [environment.md](../../docs/specs/environment.md) drop the flag from their metadata listings.

### The season override, made real

In `backend/src/storage/season-config.ts`, replace the parsed-but-inert `llm: z.record(z.string(), z.unknown())` with a strict `LlmOverrideSchema`, following `MessagingOverrideSchema`:

```ts
llm?: {
  enabled?: boolean            // default false: a season must opt in
  models?: string[]            // subset of the deployment's configured tiers
  session_token_budget?: number; session_call_budget?: number   // per slot per session
  run_token_budget?: number;   run_call_budget?: number         // per submission per run (consumed in step 4)
  rate_limit_rpm?: number
}
```

- `PUT /api/admin/seasons/:id/config` (`backend/src/admin/routes.ts`) validates `models` against the deployment's configured tiers (the `LLM_MODEL_*` mapping from step 1) and rejects unknown names with the existing `invalid_config` shape naming the offender.
- Budget and rate values replace the deployment defaults from step 1. These are operator-set numbers on an operator-only surface, so there is no tighten-only rule the way messaging needed; the one non-negotiable is that `models` cannot escape the deployment's configured tiers.
- The admin console's `SeasonConfigEditor.vue` replaces its preserved-untouched `llm` block with a real section beside the messaging fields: an enable toggle, a free-text tier list (the server validates against the configured tiers; no new API surface for the list itself), and the budget and rate fields.

### Resolution and both launch paths

- `resolveLlm(config, override)` lands beside `resolveMessaging` in `backend/src/session/orchestrator.ts`: enabled if and only if the deployment configured an upstream **and** the season override says `enabled: true`; effective models, budgets, and rate fall back from override to deployment defaults.
- Live sessions resolve against the play-open season (the Stage 8 orchestrator-applies-overrides precedent); the workflow runner resolves against the run's frozen `config_snapshot`.
- The resolved flag persists on the session row (`llm_enabled` beside `messaging_enabled` in `SessionsTable`, plus a migration), so a reopened ended session and the later frontend read the same truth the container ran under.

At launch the orchestrator calls `KeyRegistry.issue` for every **agent** slot — built-ins included (an unused key costs nothing, and a future built-in that consults the model just works); external human slots run no code in the container and get no key — and threads the result into the session config argv, the channel every other per-session flag rides. Issuance names the telemetry scope — the session id here, the run id on the workflow-runner path — so every call lands in the right `data/llm` file from the first request:

```jsonc
"llm": { "base_url": "http://llm-gateway:<port>/v1", "keys": { "player_0": "sk-sandbox-…", … } }
```

- `backend/src/session/launch-config.ts` (`assembleSeats`) stays the shared seam for the orchestrator and `workflow-runner.ts`; its lockstep note with `live.py::parse_config` extends to the new block. Step 3 makes the harness consume it; until then the block is inert in the container.
- Revocation converges where teardown already converges: `LiveSession.finalize` and its constructor's `process.exited` handler for live sessions; `runGame` after `await process.exited` in the workflow runner. `revokeSession` is idempotent, so double revocation on the crash paths is harmless.
- Issuance is guaranteed-revoked: keys are minted before the driver launches, the span from `issue` to a registered teardown owner is wrapped (try/finally in `start()` and `runGame`), and any failure inside it — image ensure, network setup, `driver.launch`, config assembly — revokes on the spot. A key must never outlive a session that never started.

### The internal network

`SandboxNetwork` in `backend/src/driver/index.ts` grows the member its comment has promised since Stage 3: `'none' | 'llm'`, driver-neutral (the future Kubernetes driver expresses `'llm'` as a NetworkPolicy). Sessions resolve to `'llm'` only when LLM is enabled; everything else keeps `'none'` bit-for-bit.

On the Docker driver, `'llm'` means:

- **A per-session internal network** `game-sandbox-llm-<sessionId>` (`Internal: true`, labeled like containers with `game-sandbox.session` and `game-sandbox.owner-pid`). Per-session rather than shared because the stage promises a network "whose single reachable endpoint is the gateway": on a shared network, concurrent sessions' containers could reach each other — a cross-session channel nothing in [execution.md](../../docs/specs/execution.md) accepts.
- **A single long-lived gateway relay container** (`alpine/socat`, ensured on first use, labeled, restart-on-failure) as the one dual-homed party: it forwards its listen port to `host.docker.internal:<LLM_GATEWAY_PORT>`, launched with `--add-host=host.docker.internal:host-gateway` so the same image and config work on Docker Desktop (Windows dev) and native Linux (CI, deployment). The backend's gateway listener is a host process, and internal networks have no route to the host on Docker Desktop — the relay is what makes "embedded in the backend" reachable from inside the sandbox on every platform.
- **Lifecycle**: at session launch the driver connects the relay to the session's network under the alias `llm-gateway`, then starts the session container with `NetworkMode` set to that network; at teardown it disconnects the relay and removes the network. `reapOrphans` extends to labeled relays and networks so a crashed backend leaves nothing behind.

The container-visible base URL is therefore always `http://llm-gateway:<port>/v1`, independent of platform. If per-session connect/disconnect churn proves flaky in practice, the recorded fallback is one shared internal network with the cross-session-reachability tradeoff documented in execution.md — but per-session is the default because it matches the spec sentence as written.

## Tests

Docker-free (fake driver and registry):

- `LlmOverrideSchema` accepts the full shape, rejects unknown fields and out-of-allowlist models with `invalid_config`, and round-trips through the season editor payloads.
- The `resolveLlm` matrix: unset override, `enabled: false`, `enabled: true` without a configured upstream, and `enabled: true` with one — only the last enables; models, budgets, and rate fall back correctly.
- An enabled launch issues one key per agent slot and none for external slots; the session config carries the base URL and the exact key map; a disabled launch carries no `llm` block, `network: 'none'`, and issues nothing.
- `finalize`, container exit, and workflow `runGame` completion each revoke the session's keys exactly once; revoked keys fail `authenticate`.
- A launch that fails after issuance leaves no live keys: a fake driver that throws at each stage — image ensure, network setup, `launch` itself — exercises every pre-teardown failure path.
- The migration adds `llm_enabled` and existing rows read as disabled.

Docker-gated, in the existing `backend-integration` lane:

- From inside an LLM-enabled session container, the gateway answers through the relay alias, and a request to the open internet fails (no route, not a timeout-that-eventually-succeeds).
- A session without LLM has `NetworkMode: none` exactly as today.
- After the container exits, its saved slot key gets 401 from the gateway, and the session's network and relay attachment are gone; `reapOrphans` removes a deliberately orphaned network.

## Done when

- An operator flips `enabled: true` with a model list and budgets in a season's LLM override through the admin console, and every session launched against that season — live watch/play and workflow matches alike — starts with per-slot keys issued, an internal network whose only reachable endpoint is the gateway relay, and the resolved flag persisted on the session row.
- From inside such a container the gateway answers and the internet does not; after exit the keys are dead and the network is gone.
- Sessions of seasons that never opted in are byte-identical to today.
- `EnvironmentMeta.llm` no longer exists anywhere in the tree, and llm.md, environment.md, and the Stage 2 subplan describe the season-only model.
- All Docker-free tests pass without Docker; the network truths are pinned in the Docker-gated lane.
