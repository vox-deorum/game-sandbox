# Stage 6.6: Ratings and the Human-Feedback Board

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 6: collecting 1-5 ratings after a session, enforcing the one-effective-rating and own-agent-exclusion rules, surfacing the two optional rating prompts (the operator's iteration prompt and the agent author's per-submission prompt) that guide the rater, and computing the human-feedback board (mean rating and count, ranked only at three ratings). It spans backend (the `ratings` and `agent_rating_prompts` tables and the `iterations.rating_prompt` column from step 1, the write/read API) and frontend (the post-session rating UI on the watch and play flows, plus the author's prompt editor on the agent profile).

## Rating rules

Per [frontend.md](../../docs/specs/frontend.md):

- After **any** session (watch or play), the user can rate **each agent involved** on a 1-5 scale.
- **One effective rating per user per agent per iteration**: re-rating overwrites the previous value, keyed by the shared `AgentRef` columns from step 1.
- **Own-agent ratings are excluded**: a user cannot rate their own submitted agent; the API rejects it and the UI does not offer it for the user's own agent. The built-in Naive baseline has no owner and is rateable.
- Ratings feed only the **human-feedback** board and never the automated one.

Ratings target the exact `AgentRef` values involved in the session, not only submissions. A session is tied to an iteration through the nullable `sessions.iteration_id` added in step 1, written for new watch and play sessions at session start. The authoritative source of which agents were involved is the **finished recording's header `players` attribution** ([recording.md](../../docs/specs/recording.md)), which names every slot's driver — submission, Naive baseline, or human — for both submitted and built-in slots; `session_submissions` covers only submitted slots and so cannot, on its own, surface a pure-Naive watch session. Because end-of-session feedback runs after the recording is finalized, the header is available at rating time; the route reads it (falling back to `session_submissions` plus the session's slot metadata if a header read fails) to build the allowed rateable-agent set. Old sessions with null `iteration_id` cannot be rated because the per-iteration boundary is unknown.

## Rating prompts

Two optional prompts guide what the human is rating; both are guidance for the single 1-to-5 score, not extra scores (see [leaderboard.md](../../docs/specs/leaderboard.md) and [frontend.md](../../docs/specs/frontend.md)):

- The **iteration prompt** is the operator's `iterations.rating_prompt` (step 1), applying to every agent in the iteration.
- The **author prompt** is the agent owner's `agent_rating_prompts` row for `(iteration_id, owner_user_id)` (step 1), applying only to that owner's agent. The author sets and edits it from their agent profile; it is presentation metadata, not part of the pinned submission.

The Naive baseline has no author, so only the iteration prompt applies to it. The rating-read endpoint returns, per rateable agent, the iteration prompt and that agent's author prompt (resolved by the involved submission's `user_id`), so the UI can show both next to the rating control.

## API

New routes in the backend HTTP layer, attributing each rating to the resolved identity from the Stage 4 seam (never a body-supplied user):

- **Rate**: `POST /api/sessions/:sessionId/ratings`: body is a list of `{ agent, score }`, where `agent` is the wire form of `AgentRef` (`{ kind: 'submission', submission_id }` or `{ kind: 'builtin-naive' }`); the wire form carries no `user_id`. The route resolves `sessions.iteration_id`, rejects null-iteration sessions with `409 session_not_rateable`, resolves the allowed agent refs actually involved in that session (from the recording header above), rejects a score outside 1-5, and rejects rating an agent not actually in that session. For each submitted agent it resolves the owner `user_id` **server-side** from the submission and rejects rating the caller's own submitted agent (resolved `user_id == identity`) with a specific reason; the client never asserts the owner. Each accepted rating is an `upsertRating` (step 1), so submitting again overwrites. The route returns the caller's current effective ratings for the session's agents so the UI can reflect the saved state.
- **Read own ratings and prompts**: `GET /api/sessions/:sessionId/ratings`: returns, per rateable agent in the session, the caller's existing rating (so the post-session UI pre-fills what the user already rated and re-rating shows the prior value) **and the two applicable prompts** — the iteration's `rating_prompt` and that agent's author prompt — so the UI renders the prompts without a second request. It returns the same `session_not_rateable` conflict for old null-iteration sessions.
- **Set author prompt**: `PUT /api/iterations/:iterationId/agent-rating-prompt`: the agent owner sets or clears their own per-iteration author prompt (`upsertAgentRatingPrompt`, keyed by the caller's resolved identity, never a body-supplied user). The caller must have an agent (a submission) in that iteration; otherwise `409 no_agent_in_iteration`. This is a participant action, not an operator one, so it is **not** under `/api/admin`. The owner reads it back with `GET /api/iterations/:iterationId/agent-rating-prompt` to populate the editor on their agent profile.
- **Human board read**: folded into the public board service (step 5/7): `getHumanBoard(iterationId)` aggregates `ratings` by `AgentRef` into mean and count, **ranking only agents with at least three ratings**. Agents with one or two ratings are shown unranked below the ranked set with their mean/count so feedback can be seen accumulating without assigning a rank. Public reads serve only a published iteration's human board; the admin view can see a draft's.

## Frontend: post-session rating UI

At the end of a session, alongside the existing feedback prompt and the pin-replay affordance ([frontend.md](../../docs/specs/frontend.md), wired in Stage 4), present a rating control per involved agent:

- A 1-5 control (stars or segmented buttons) per rateable agent in the session, built on the Stage 4.5 primitives so it inherits the design system. The user's **own** submitted agent is shown without a rating control (labeled as the user's agent), reflecting the exclusion. The Naive baseline gets a normal rating control when it was involved.
- **The two prompts are shown next to each agent's control** when present, each clearly attributed — the operator's iteration prompt and the agent author's prompt — so the rater knows what to consider. Both come from the rating-read payload, so no extra request is needed. The Naive baseline shows only the iteration prompt.
- Submitting calls the rate route; the control shows the saved state and allows changing it (which overwrites). The UI reads the caller's existing ratings so reopening a session the user already rated shows their prior values.
- This attaches to **both** the watch flow (Stage 5 watch-run) and the play flow (Stage 4 live play) end-of-session points, since ratings come from any session. The control is the same component in both; only the set of involved agents differs (watch single-agent now, multi-agent in Stage 7 reuses the same component for every seat).

## Frontend: author prompt editor

On the agent profile ([frontend.md](../../docs/specs/frontend.md), Stage 5.6), the agent's **owner** gets a small editor (shown only to the owner, for the current iteration) to set or clear their per-submission rating prompt — "what should people evaluate about my agent?" — calling the set/get author-prompt routes above. It is plain presentation metadata, kept distinct from the submission's validated artifact and build/validation status on the same page. Non-owners do not see the editor; they only see the prompt later at rating time if they rate this agent.

The human-feedback board's display (mean + count, the three-rating ranking rule) lives in the Leaderboards view built in step 7; this step provides its data (`getHumanBoard`) and the collection UI.

## Tests

- **Backend (Vitest, `:memory:`):** a rating of a submitted agent in a session is stored under the caller's identity; a rating of the Naive baseline in a session is stored and aggregates under `builtin-naive`; a second rating by the same user for the same agent ref overwrites rather than duplicating; a score outside 1-5 is rejected; rating an agent not in the session is rejected; the own-agent rejection resolves the owner server-side (a body that omits or spoofs the owner still cannot rate the caller's own agent); a session with null `iteration_id` returns `session_not_rateable`; reading own ratings returns the effective values **and the applicable iteration and author prompts per agent**; the set-author-prompt route stores under the caller's identity and `409 no_agent_in_iteration`s a caller with no submission in the iteration; `getHumanBoard` returns mean and count per agent ref and ranks only agents with at least three ratings while surfacing under-threshold agents as unranked; a draft iteration's human board is admin-only.
- **Frontend (Vitest, jsdom, mocked fetch):** the post-session UI renders a rating control per involved rateable agent including Naive and none for the user's own submitted agent; the iteration and author prompts render next to the right agents and Naive shows only the iteration prompt; submitting posts the scores and reflects the saved state; reopening pre-fills prior ratings; changing a rating re-posts and overwrites; the agent-profile author-prompt editor shows only to the owner, posts the prompt, and reflects the saved value. Follows the Stage 4/5 frontend-unit pattern (no canvas, no real network).

## Done when

After a watch or play session the user rates each involved rateable agent 1-5, including the Naive baseline when present; their own submitted agent is not ratable; re-rating overwrites; the operator's iteration prompt and the agent author's per-submission prompt are shown next to the relevant agents at rating time, with the author able to set their prompt from the agent profile; and the human-feedback board aggregates mean and count by `AgentRef`, ranking an agent only once it has three ratings and showing under-threshold rows unranked. The board data this produces is rendered alongside the automated board in step 7.
