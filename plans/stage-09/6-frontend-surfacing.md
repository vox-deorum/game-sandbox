# Stage 9.6: Replay Metadata, the Owner Debug View, and Board Tokens

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md). This is build-order step 6: everything the stage built becomes visible, at exactly the visibility the spec draws. Per-tick model, token, and latency metadata is public wherever the replay is public; full prompts and completions appear only in the owner's debug view on the agent profile (and to operators); the automated board gains its token-usage-by-model column next to timing. The hands-on surface at the end of this step is the whole story in a browser: scrub a replay and watch the model calls tick by, open your agent's profile and read the exact prompts it sent, open the same profile logged out and see none of them, and find the token column on the board.

## Why this is its own seam

The three surfaces share one data source — the step 4 sidecar — and one authorization question: who may read prompt bodies. Answering that question once, server-side, in one endpoint, and then building the three views against it, is the shape `recordings-view.ts` already established for blind attribution: masking that matters "cannot live only in the browser," because the recordings API is public and a caller bypassing the UI would otherwise read exactly what the rule is meant to hide. The frontend's `isOwner()` checks are display conveniences; the endpoint is the boundary.

## What to build

### The sidecar endpoint, masked per slot

`GET /api/recordings/:id/llm` in `backend/src/app.ts`, public like the recording stream, backed by step 4's `streamSidecar`: 404 when the recording exists but declares no telemetry sidecar (or has not been finalized), otherwise the parsed rows as JSON. Every row always carries the public fields — tick, slot, model, token counts, latency, status, error code. The `request` and `response` bodies are included **per row** only when the caller (identity from the session via `identity.ts`, never from a query parameter) is an operator or owns the submission controlling that row's slot, resolved server-side by one resolver anchored on the recording header's player attribution joined to authoritative submission ownership in storage. The header is the anchor because it is the one attribution source both kinds of recording share — an automated season run has no producing session row, so the sessions table cannot be; the same resolver must therefore serve live and workflow recordings alike. In a multi-agent session an owner therefore sees their own seat's prompts and only metadata for everyone else's — ownership is per slot, not per recording. Blind-season handling needs no new rule: prompts identify no one, the metadata was always public, and the existing attribution masking already governs names.

### The replay viewer panel

`ReplayPage.vue` fetches the endpoint when the parsed header declares the `llm-telemetry` sidecar (the `parse.ts` parser starts surfacing `header.sidecars`). A new "Model calls" panel joins the `.stage-log` region beside `DecisionLog`/`GameThread`, following the chat pattern exactly: rows accumulate into a tick-keyed list, a `visibleLlm` computed filters by `replayState.tick`, and the current tick highlights as the scrubber moves. Each row renders compactly — slot, model, input/output tokens, latency, an error badge for failed calls. The panel is deliberately metadata-only for every viewer, owners included: the stage text puts prompt reading on the profile, and keeping the replay panel uniform means no viewer-dependent layout shifts on a public page. `RunMetadata` gains a whole-run summary item (total calls and tokens) so a replay's cost is visible without scrubbing. A declared-but-absent sidecar (in-flight session) renders as an empty state, not an error.

### The owner debug view on the agent profile

`AgentProfilePage.vue` replaces its Stage 5 placeholder — the `isOwner()`-gated "Your agent's LLM debug view arrives in a later stage" paragraph — with the real thing: within the existing submission history, each recording chip whose recording carries telemetry opens a debug panel that fetches the same endpoint and renders this agent's calls grouped by tick, with the full prompt messages and completion text expandable per call, token and latency badges, truncation and error markers included. Operators see the same view on any profile (the spec's "owner and operators"). The client gate mirrors the server's; the note in `app.ts` that the profile is public stays true because the sensitive payload never leaves the masked endpoint.

### The board column

`AutomatedBoardRow` in `frontend/src/api/client.ts` gains `token_usage_by_model` (step 5 already serves it), and the automated table in `LeaderboardBoards.vue` gains a "Tokens" column beside Agent compute: per model, a compact `in/out` figure (reasoning folded into a tooltip), an em-dash for agents that made no calls, and the Naive baseline naturally blank. The human-feedback board is untouched — tokens are an automated-board fact. The live session page deliberately gains nothing in this stage: the surfaces the spec names are replay, profile, and board.

## Tests

Backend (vitest): the masking matrix — anonymous, a signed-in non-owner, the owner of one slot in a multi-agent recording, and an admin each get exactly their rows' bodies and everyone's metadata; the same matrix over a multi-submission **workflow** recording with no session row resolves every owner correctly; 404 for a recording without the sidecar; identity is never read from the query.

Frontend (vitest, component): the Model-calls panel renders fixture rows, filters by transport tick, shows the error badge, and mounts only when the header declares the sidecar; the debug view renders prompts for an owner fixture and never renders body fields absent from the response (the masked case); the board column formats multi-model usage and the em-dash case; `parse.ts` surfaces declared sidecars without disturbing existing fixtures.

The browser journey that ties all three together is step 7's e2e.

## Done when

A public replay of an LLM session shows every model call at its tick — model, tokens, latency, failures flagged — to any visitor, with a run-cost summary in the metadata strip, and shows prompt text to no one. The agent's owner opens their profile and reads every prompt and completion their agent exchanged in that session, an operator can do the same, and any other caller hitting the API directly gets metadata only. The automated board shows token use by model next to compute time without affecting rank. All component and masking tests are green Docker-free.
