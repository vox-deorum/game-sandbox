# Stage 9.5: Replay Metadata, the Owner Debug View, and Board Tokens

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 5: everything the stage built becomes visible, at exactly the visibility the spec draws — per-tick tier, token, and latency metadata public wherever the replay is public; full prompts and completions only in the owner's debug view on the agent profile (and to operators); the token-usage-by-tier column on the automated board next to timing.

**Hands-on result:** the whole story in a browser — scrub a replay and watch the model calls tick by, open your agent's profile and read the exact prompts it sent, open the same profile logged out and see none of them, and find the token column on the board.

## Why this is its own seam

- The three surfaces share one data source — the per-scope telemetry files under `data/llm/` — and one authorization question: who may read prompt bodies. Answering it once, server-side, in one endpoint, then building the three views against it, is the shape `recordings-view.ts` established for blind attribution.
- Masking that matters "cannot live only in the browser": the recordings API is public, and a caller bypassing the UI would otherwise read exactly what the rule is meant to hide. The frontend's `isOwner()` checks are display conveniences; the endpoint is the boundary.

## What to build

### The telemetry endpoint, masked per slot

`GET /api/recordings/:id/llm` in `backend/src/app.ts`, public like the recording stream:

- The backend resolves the recording to its telemetry scope — the run behind a workflow recording, the session behind a live one — and reads `data/llm/<scopeId>.sqlite` filtered to that recording's session, in insertion order. 404 when the recording has no scope file or no rows for its session (a non-LLM session); an in-flight session serves its rows so far, since telemetry is written through with no finalize gate.
- This resolver is also where the step 1 lifecycle rule gets its hook: deleting a recording deletes the scope's file once no surviving recording references it — a live session's file dies with its one recording, a run's file with the last of the run's recordings — with step 1's startup sweep covering orphans.
- Every row always carries the public fields — tick, slot, tier, token counts, latency, status, error code.
- The `request` and `response` bodies are included **per row** only when the caller is an operator or owns the submission controlling that row's slot. Identity comes from the session via `identity.ts`, never a query parameter; ownership is resolved server-side by one resolver anchored on the recording header's player attribution joined to authoritative submission ownership in storage.
- The header is the anchor because it is the one attribution source both kinds of recording share — an automated season run has no producing session row, so the sessions table cannot be it; the same resolver must serve live and workflow recordings alike.
- In a multi-agent session an owner therefore sees their own seat's prompts and only metadata for everyone else's — ownership is per slot, not per recording. Blind-season handling needs no new rule: prompts identify no one, the metadata was always public, and the existing attribution masking already governs names.

### The replay viewer panel

- `ReplayPage.vue` fetches the endpoint alongside the recording; a 404 simply means no panel — the recording format itself carries no LLM trace, so the fetch is the discovery mechanism.
- A new "Model calls" panel joins the `.stage-log` region beside `DecisionLog`/`GameThread`, following the chat pattern exactly: rows accumulate into a tick-keyed list, a `visibleLlm` computed filters by `replayState.tick`, and the current tick highlights as the scrubber moves.
- Each row renders compactly — slot, tier, input/output tokens, latency, an error badge for failed calls.
- The panel is deliberately metadata-only for every viewer, owners included: the stage puts prompt reading on the profile, and a uniform panel means no viewer-dependent layout shifts on a public page.
- `RunMetadata` gains a whole-run summary item (total calls and tokens) so a replay's cost is visible without scrubbing.

### The owner debug view on the agent profile

- `AgentProfilePage.vue` replaces its Stage 5 placeholder — the `isOwner()`-gated "Your agent's LLM debug view arrives in a later stage" paragraph — with the real thing: within the existing submission history, each recording chip whose recording has telemetry (the same fetch decides) opens a debug panel against the same endpoint.
- The panel renders this agent's calls grouped by tick, with the full prompt messages and completion text expandable per call, token and latency badges, and truncation and error markers.
- Operators see the same view on any profile (the spec's "owner and operators"). The client gate mirrors the server's; the note in `app.ts` that the profile is public stays true because the sensitive payload never leaves the masked endpoint.

### The board column

- `AutomatedBoardRow` in `frontend/src/api/client.ts` gains `token_usage_by_model` (step 4 already serves it), and the automated table in `LeaderboardBoards.vue` gains a "Tokens" column beside Agent compute: per tier, a compact `in/out` figure (reasoning folded into a tooltip), an em-dash for agents that made no calls, and the Naive baseline naturally blank.
- The human-feedback board is untouched — tokens are an automated-board fact. The live session page deliberately gains nothing in this stage: the surfaces the spec names are replay, profile, and board.

## Tests

Backend (vitest):

- The masking matrix — anonymous, a signed-in non-owner, the owner of one slot in a multi-agent recording, and an admin each get exactly their rows' bodies and everyone's metadata.
- The same matrix over a multi-submission **workflow** recording with no session row resolves every owner correctly, reading the run's shared file filtered to the game's session.
- 404 for a recording without telemetry; identity is never read from the query.
- Deleting a live recording removes its scope file; deleting one of a run's recordings keeps the run's file until the last one goes.

Frontend (vitest, component):

- The Model-calls panel renders fixture rows, filters by transport tick, shows the error badge, and mounts only when the endpoint returns rows.
- The debug view renders prompts for an owner fixture and never renders body fields absent from the response (the masked case).
- The board column formats multi-tier usage and the em-dash case.

The browser journey that ties all three together is step 6's e2e.

## Done when

- A public replay of an LLM session shows every model call at its tick — tier, tokens, latency, failures flagged — to any visitor, with a run-cost summary in the metadata strip, and shows prompt text to no one.
- The agent's owner opens their profile and reads every prompt and completion their agent exchanged in that session; an operator can do the same; any other caller hitting the API directly gets metadata only.
- The automated board shows token use by tier next to compute time without affecting rank.
- Telemetry files are deleted exactly when the recordings referencing them are gone.
- All component and masking tests are green Docker-free.
