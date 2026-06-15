# Stage 6.6: Ratings and the Human-Feedback Board

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 6: collecting 1–5 ratings after a session, enforcing the one-effective-rating and own-agent-exclusion rules, and computing the human-feedback board (mean rating and count, ranked only at three ratings). It spans backend (the `ratings` table from step 1, the write/read API) and frontend (the post-session rating UI on the watch and play flows).

## Rating rules

Per [frontend.md](../../docs/specs/frontend.md):

- After **any** session (watch or play), the user can rate **each agent involved** on a 1–5 scale.
- **One effective rating per user per agent per iteration** — re-rating overwrites the previous value (the upsert on the unique `(iteration_id, rater_user_id, agent_submission_id)` index from step 1).
- **Own-agent ratings are excluded** — a user cannot rate their own submission; the API rejects it and the UI does not offer it for the user's own agent.
- Ratings feed only the **human-feedback** board and never the automated one.

The rating targets the agent's **active submission in the iteration the session belonged to**, so a session is tied to an iteration (it already runs against the open iteration's images via the Stage 5 attribution) and the rating is grouped the same way the automated board groups — by submission/owner — so the two boards line up under the same agent identity.

## API

New routes in the backend HTTP layer, attributing each rating to the resolved identity from the Stage 4 seam (never a body-supplied user):

- **Rate** — `POST /api/sessions/:sessionId/ratings` (or `/api/iterations/:id/ratings` keyed by the session's iteration): body is a list of `{ agent_submission_id, score }` for the agents in that session. The route resolves the session's iteration and the involved agents from `session_submissions` (Stage 5.1), rejects a score outside 1–5, rejects rating an agent not actually in that session, and rejects rating the caller's own agent (`agent_owner_id == identity`) with a specific reason. Each accepted rating is an `upsertRating` (step 1), so submitting again overwrites. The route returns the caller's current effective ratings for the session's agents so the UI can reflect the saved state.
- **Read own ratings** — `GET` of the caller's existing ratings for a session/iteration, so the post-session UI pre-fills what the user already rated (re-rating shows the prior value).
- **Human board read** — folded into the public board service (step 5/7): `getHumanBoard(iterationId)` aggregates `ratings` by `agent_submission_id` into mean and count, **ranking only agents with at least three ratings**; agents with one or two ratings are either omitted from the ranked board or shown unranked/"needs more ratings" (state which — show them unranked below the ranked set so an owner sees feedback is accruing). Public reads serve only a published iteration's human board; the admin view can see a draft's.

## Frontend: post-session rating UI

At the end of a session, alongside the existing feedback prompt and the pin-replay affordance ([frontend.md](../../docs/specs/frontend.md), wired in Stage 4), present a rating control per involved agent:

- A 1–5 control (stars or buttons) per agent in the session, built on the Stage 4.5 primitives so it inherits the design system. The user's **own** agent is shown without a rating control (or labeled "your agent"), reflecting the exclusion.
- Submitting calls the rate route; the control shows the saved state and allows changing it (which overwrites). The UI reads the caller's existing ratings so reopening a session the user already rated shows their prior values.
- This attaches to **both** the watch flow (Stage 5 watch-run) and the play flow (Stage 4 live play) end-of-session points, since ratings come from any session. The control is the same component in both; only the set of involved agents differs (watch single-agent now, multi-agent in Stage 7 reuses the same component for every seat).

The human-feedback board's _display_ (mean + count, the ≥3 ranking rule) lives in the Leaderboards view built in step 7; this step provides its data (`getHumanBoard`) and the collection UI.

## Tests

- **Backend (Vitest, `:memory:`):** a rating of an agent in a session is stored under the caller's identity; a second rating by the same user for the same agent overwrites rather than duplicating; a score outside 1–5 is rejected; rating an agent not in the session is rejected; rating the caller's own agent is rejected with a specific reason; reading own ratings returns the effective values; `getHumanBoard` returns mean and count per agent and ranks only agents with ≥3 ratings while surfacing under-threshold agents as unranked; a draft iteration's human board is admin-only.
- **Frontend (Vitest, jsdom, mocked fetch):** the post-session UI renders a rating control per involved agent and none for the user's own agent; submitting posts the scores and reflects the saved state; reopening pre-fills prior ratings; changing a rating re-posts and overwrites. Follows the Stage 4/5 frontend-unit pattern (no canvas, no real network).

## Done when

After a watch or play session the user rates each involved agent 1–5, their own agent is not ratable, re-rating overwrites, and the human-feedback board aggregates mean and count, ranking an agent only once it has three ratings — the human half of the stage's "Done when." The board data this produces is rendered alongside the automated board in step 7. </content>
