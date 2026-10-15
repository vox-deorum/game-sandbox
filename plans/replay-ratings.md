# Replay Ratings, Leaderboards Order, and Matchup Results

Status: complete.

## Goal

Extend human feedback from the session page to replays. While a season's play window is open, a signed-in viewer of a replay that belongs to that season can rate its agents in the same panel the live session page shows after a session ends, under the same rules. The Leaderboards page puts All Seasons above Matchups, and the Matchups table shows each seat's per-game score. No schema change was needed: a replay rating writes the same effective rating row a session rating does, stored once per (season, rater, agent).

## Mechanism

- **One panel, two mounts**: `SessionRatings.vue` renders on `SessionPage.vue` after a session ends and on `ReplayPage.vue`, above the stage, once the playhead first reaches the final frame, and it stays visible when the viewer scrubs back. The panel never appears for anonymous visitors, for a replay with no season, or once the season's play window closes. Every rule is shared with the session page: a 1 to 5 score with a required written comment per agent, no rating your own agent, builtin-only games are not rateable, and closed play refuses writes.
- **Recording season**: a recording belongs to the season of the session that produced it; a tournament (automated run) game's recording, which has no session, belongs to the season of its run. Storage owns this rule: `findRecordingOrigin` in `src/storage/kysely/recordings.ts` resolves one recording for the rating routes and the replay stream, and `listRecordingSeasons` resolves every recording for the replay listing. Tournament replays therefore follow the blind-label rule while play is open: operators see real names, everyone else sees masked or numbered labels.
- **Routes**: `GET` and `POST /api/recordings/:id/ratings` sit beside `/api/sessions/:id/ratings` and share one validation path. A recording a session produced follows its session's rules; a tournament game's recording is rateable once the game is no longer pending or running. A missing recording returns 404 `no_such_recording`. An unrateable or unfinished game returns 409 `not_rateable` or `not_finished` on either route. Rating the same agent again from either source updates the same stored rating.
- **Leaderboards page order**: the page shows the selected season's header and boards, then (operators only) the season's peer ratings, then the **All Seasons** table, then the **Matchups** table.
- **Matchup results**: the Matchups table (every game of the latest completed run) and the operator run-details page's games table show each seat's normalized per-game episode score after the agent name, where higher is better. The top non-failed score is bold, with every tied seat bold. A seat that failed gets a **failed** tag and carries the environment's forfeit score. The API's run game view carries `results: [{ seat_index, episode_score, failed }]` in seat order, and only once every seat has a result: the workflow records seats one at a time, so a game read mid-write or interrupted after a partial write shows names only rather than a partial winner.

```text
Game               Players                                     Status     Replay
m0 · g1 · seed 7   **Alice 26** · Bob 0 · Cara -26 [failed]     completed  Replay
```

Each seat reads as a name and its score, so a row shows who won at a glance: the winner is bold, and a failed seat shows the forfeit score with its tag.

## Files

- backend/src/ratings/routes.ts (both rating routes, shared validation, recording season resolution)
- backend/src/recordings/retention.ts, backend/src/recordings/routes.ts (recording metadata reads carry the resolved season)
- backend/src/storage/kysely/recordings.ts (`findRecordingOrigin`, `listRecordingSeasons`)
- backend/src/storage/kysely/runs.ts (results in seat order)
- backend/src/seasons/views.ts, backend/src/leaderboards/routes.ts, backend/src/admin/routes.ts (run game views gain `results`)
- frontend/src/api/client.ts (recording rating calls, run game result types)
- frontend/src/components/SessionRatings.vue, frontend/src/pages/ReplayPage.vue (the panel on a replay)
- frontend/src/components/GamesTable.vue, frontend/src/pages/LeaderboardsPage.vue (per-seat scores, section order)
- backend and frontend tests
- docs/specs/frontend.md, docs/specs/leaderboard.md, docs/specs/overview.md, docs/specs/recording.md, docs/contributors/runtime/backend.md
