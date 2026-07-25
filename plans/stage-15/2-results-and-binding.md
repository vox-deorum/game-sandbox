# Stage 15.2: Results and binding move to the seat

Status: not started.

Part of [Stage 15](../stage-15-wide-seats.md), build-order step 2.

## Outcome

The live-session and workflow paths expand each resolved seat into player bindings, while recordings and leaderboard results contain one reduced row per seat. An agent seat repeats one agent binding across its players. A wide human seat makes its first human-capable member external and uses one explicitly selected companion agent for every remaining member. All current environments still resolve to singleton seats, so scores, standings, and replay labels remain behaviorally identical while the full wide-seat path becomes testable with synthetic layouts.

The hands-on check launches a fixture layout with seats of different widths. One submitted agent is staged once per seat, loaded as a separate agent instance for each player in that seat, and produces one standings row whose score is the mean of its player scores.

## Expand seat assignments into player bindings

Refactor `backend/src/session/launch-config.ts` so its input is a map of `seat_N` to `SeatBinding`, while its output is explicitly player-named:

- `SeatBinding` keeps its name and becomes genuinely one per seat. Its ordinary variants are Naive and submission. Its human variant carries the one companion agent binding required when the seat has more than one player.
- `SlotConfig` becomes `PlayerConfig`, one per PettingZoo position.
- `assembleSeats` becomes `assembleLaunch`, since it now takes seats and returns players rather than working in one currency.
- The harness runtime-binding map becomes `player_bindings`, keyed by `player_N`.
- The existing recording attribution map remains named `players`, also keyed by `player_N`.

The assembly function also receives the resolved layout and `human_players`. For an ordinary seat it emits one player configuration and attribution entry for every member, using a separate Naive or submission instance for each. For a human seat it selects the first member in declared seat order that occurs in `human_players`, makes only that player external, and applies the chosen companion binding to every other member. A submitted companion points those players at the same staged seat overlay path while the harness constructs separate in-process objects. Reject a human seat with no capable member, a missing companion for a wide seat, an unnecessary companion for a singleton, or a companion whose binding is human. No shared object or shared memory is introduced.

Return both maps as one `AssembledLaunch` value with distinct `player_bindings` and `players` fields. Reject a missing or extra seat assignment before expansion, and reject a layout that would cause the same player to be emitted twice even though metadata validation should already make that impossible.

The launch config carries no seat-to-player map. The harness already receives the environment id and the complete parameter map, and [step 1](1-split-player-from-seat.md) gives it a Python resolver, so it derives the layout itself and passes it to `Episode` and `build_header`. The layout has one source, the environment metadata, and a launch caller has no way to state a competing one.

Update both callers, `backend/src/session/orchestrator.ts` and `backend/src/workflow/workflow-runner.ts`, to resolve the layout once and pass it to launch-config assembly. The live orchestrator also passes human capability and the companion choice. LLM grants and keys are issued for every expanded agent-controlled `player_N`, including companion players, and the harness continues recording per-player LLM usage before the runner reduces it.

Extend the harness `LiveConfig` parser to validate `player_bindings` and `players` against the player-id set of the layout it resolved. A binding or attribution entry naming a player outside that set is a config error.

Update `scripts/play.py` and the generated template local runner to emit both objects. Harness and local-play fixtures exercise this path directly, so adding the header field does not depend on a backend-launched container.

## Stage and attribute once per seat

Rename `CANONICAL_SUBMISSION_SLOT` and `submissionSlotPath` in `backend/src/submission/submission-image.ts` to seat vocabulary. The live orchestrator and workflow runner resolve, build, and stage a submitted overlay once for each assigned seat, then reuse that seat path for every player driven by that submission. A submitted companion uses the human seat's path for all nonhuman members. The same submission assigned to two different seats receives two distinct seat paths and two independent groups of player instances.

Insert one `session_submissions` row per seat containing a submission using `seat_id`, including a submitted companion. Recording player attribution repeats the submission id and label only on the players that submission drives; a mixed human seat records the person on its human player and the companion on every other member. This lets state frames and chat retain exact acting-player identity while the new header map supplies the grouping.

## Pure seat reduction

`backend/src/workflow/aggregate.ts` already works one PettingZoo position at a time, so `aggregateSeat` and `SeatAggregate` become `aggregatePlayer` and `PlayerAggregate`. That frees the seat name for the reduction that now follows them, and it is the same split as `launch-config.ts` above: the per-position work keeps the player name, the per-assignment work keeps the seat name.

Split the existing workflow aggregation into two phases:

1. Build one complete `PlayerResult` for every resolved player from the harness score envelope, compute telemetry, acted ticks, LLM telemetry, process exit, and `failed_player`.
2. Reduce the players named by each seat into exactly one `SeatResult`.

Put the reduction in a pure helper that takes the resolved layout and player results, and returns results in seat order. It implements the Stage 15 table directly:

- `episode_score` is the arithmetic mean of member player scores.
- `agent_compute_ms_total`, `acted_tick_count`, every numeric field inside `llm_usage_by_model`, and `llm_weighted_cost` are sums.
- `failed` is true when any member player failed.
- `failure_reason` identifies the failing `player_N`. `EpisodeResult.failed_player` is one optional id, so a seat has at most one attributed failing player and the reducer needs no rule for choosing among several.

Treat the harness `EpisodeResult.scores` map as authoritative. Every resolved player must have a finite score before reduction. A missing, extra, or nonfinite player score is an unattributed game fault, not a partial result. A reported `failed_player` must name a player in the layout. An attributed player crash, illegal action, or episode-budget timeout marks only that player's seat failed. An `act` call that exceeds `step_limit_ms` keeps the existing behavior: discard the late action, apply the legal default, count and charge the overrun, and continue without marking the seat failed. A later `chat` or `learn` overrun preserves the chosen action and any validated messages, records and charges the timeout, and likewise does not mark the seat failed. An OOM, malformed result, missing result, or other fault that cannot be attributed to one player marks every seat failed.

In `workflow-runner.ts`, treat the stored `season_run_games.seats` array as one assignment per canonical seat. Zip array index 0 with `seat_0`, index 1 with `seat_1`, and so on after validating its length against `layout.seatCount`. Use that seat id for image staging and `session_submissions`, then expand through the layout for player bindings, LLM grants, telemetry lookups, and reduction. Never derive `player_N` directly from a scheduled array index. A focused test uses the partnership-shaped mapping `seat_0 -> [player_0, player_2]` to pin the noncontiguous expansion.

Run seat reduction before `normalizeEpisodeScore` and before applying `forfeitScore`. Persist one `game_results` row per seat with its zero-based `seat_index`. Apply the forfeit floor only to failed seats, leaving every surviving seat's honest reduced score intact. Board aggregation and placement persistence then consume seat rows without inferring partnerships from equal player values.

## Recording and presentation

Add three required fields to `schema/recording-header.schema.json`, alongside the existing `players` attribution object:

- `seats`, keyed by `seat_N`, whose values are nonempty arrays of unique `player_N` ids forming the exact player partition.
- `player_count`, the resolver's derived count.
- `seat_plan`, the resolver's canonical plan key, which is `solo` for a player-bounds environment.

All three are required, and a header missing any of them is malformed. Stage 15 targets a fresh pre-release checkout with no backward-compatibility path, so a recording written before this stage is an artifact that gets recreated rather than a shape the reader has to understand. Every supported recording therefore carries all three, and the reader has one code path.

Regenerate the TypeScript recording types and update recording fixtures. Recording validation checks `players` and `seats` independently and then their relationship: all and only attributed player ids appear once across the seats, and `player_count` equals that partition's size. Every fixture carries all three fields.

Update `backend/src/recordings.ts::winnerId` to compare reduced seat scores and return the winning `seat_N`, grouping player scores through the header's `seats` map. Preserve the existing tie sentinel only when two or more seats share the top reduced score.

Refactor `frontend/src/lib/standings.ts`, its Game Over card consumers, and replay rows to produce one row per header seat. A row retains its seat id, ordered controller attribution, member player ids for secondary detail, and reduced score. An ordinary agent seat collapses repeated player attribution to one label. A mixed human seat shows the human followed by the companion agent. Singleton recordings render the same labels and ranks as before.

Local play needs no separate implementation. `scripts/play.py` builds and serves the frontend's local bundle, which renders `GameOverCard.vue` and therefore already consumes `standings.ts`, so seat-ranked standings reach the local runner through that one change. The file header comment in `standings.ts` still calls itself "the web twin of `scripts/play.py` `_standings`", which has been stale since Stage 13 moved rendering into the browser and removed the Python side. Correct that comment here rather than writing a Python ranking helper to match it.

## Resource scaling

Memory and time scale differently, because one container runs a whole game and every agent is an in-process object inside a single interpreter. A second player adds an agent object, not a second runtime, so memory is a base plus a smaller increment while chargeable time is a straight multiple.

`SANDBOX_MEMORY_MB` keeps its meaning as the session base. Add `SANDBOX_MEMORY_PER_PLAYER_MB` beside it, and derive the profile before calling `buildSandboxProfile` in both the live orchestrator and workflow runner:

```text
SANDBOX_MEMORY_MB + SANDBOX_MEMORY_PER_PLAYER_MB * (resolved player count - 1)
```

Both values are operator-configurable through the ordinary environment-variable path. Set `SANDBOX_MEMORY_PER_PLAYER_MB=128` in the tracked `.env.default`, so a default four-player session receives 896 MB from the existing 512 MB base. A deployment that runs heavy agents or an unusually wide layout can tune either term without a code change. A one-player session receives exactly what it receives today, which keeps Flappy Bird and submission validation unchanged, and a wide layout grows in proportion to what it actually adds. Keep CPU and scratch limits unchanged. Submission validation still uses the base alone, because it loads one agent in isolation.

Add the new value to the sandbox configuration type and required integer parsing, `.env.default`, explicit config-test maps, and launch fixtures. `docs/contributors/setup/configuration.md` documents `SANDBOX_MEMORY_MB` as the session memory quota. Revise that row and add the new variable in the same change, since the quota is now a base rather than the whole allowance.

Change the workflow chargeable-wall-clock watchdog to:

```text
effective episode limit per player * resolved player count + workflow watchdog grace
```

The effective episode limit is the frozen season override when present, otherwise `EnvironmentMeta.episode_limit_ms`. Use checked safe-integer arithmetic and refuse launch on an overflow or nonpositive derived value. The per-player harness episode and step budgets remain unchanged. `SESSION_MAX_DURATION_MS` remains the fixed live-session wall-clock backstop for browser sessions, including time spent waiting for a human, and is not presented as a compute guarantee.

Keep this scaling in small pure helpers covered independently from Docker launch. The launch tests assert the exact profile and watchdog values for one-player and multi-player layouts.

## Specification edits

This step moves the result, binding, and recording contracts to the seat, so it revises:

- [Leaderboard](../../docs/specs/leaderboard.md): one episode score per seat, the reduction rules from the Stage 15 table, and forfeit scope.
- [Recording](../../docs/specs/recording.md): the seat-to-player map, mixed human and companion attribution, the materialized player count and plan key, and the seat-ranked standings card.
- [Execution](../../docs/specs/execution.md): staging per seat, and the memory and chargeable-time scaling above.
- [Submissions](../../docs/specs/submission.md): a submission bound across a seat's players or selected as a human seat's companion.
- [LLM API](../../docs/specs/llm.md): budgets and telemetry staying keyed per player, which is what makes a wide seat carry several meters.

Every one of these uses the word `seats` today to mean one PettingZoo position, so read each occurrence and decide which meaning it now carries instead of replacing the word.

## Tests

Launch-config and orchestrator tests cover:

- A singleton seat producing one player binding with unchanged attribution.
- A two-player seat producing two independent player configs from one staged submission path.
- Two seats assigned the same submission using distinct staged seat paths.
- A three-player human seat making only its first human-capable member external and expanding one selected companion into two distinct player configs and in-process agent objects that share only the staged seat path.
- Rejection of a seat with no human-capable member, a missing wide-seat companion, an unnecessary singleton companion, and a human companion binding.
- Per-player LLM keys and grants for every expanded submitted player, including companion players.
- One `session_submissions` row per seat containing a submission rather than per player.

Harness and local-play tests cover the `player_bindings` and `players` config objects, reject a binding or attribution entry naming a player outside the resolved layout, and inspect the seat map, player count, and plan key the harness derived for itself in the emitted header.

Pure reducer tests pin:

- Means for scores and sums for compute, ticks, model usage, and weighted cost.
- `sum(compute) / sum(ticks)` matching the same per-decision mean whether two players are one seat or two singleton seats.
- Logical-or failure, and a failure reason naming the failing player.
- A one-player seat beside a three-player seat.
- An episode-budget timeout forfeiting only its seat, while a late `act` applies the default action and later-hook overruns preserve it, with neither step overrun causing a forfeit.
- Missing scores, unknown failed-player ids, malformed result envelopes, and unattributed process faults forfeiting every seat.

Storage and board tests assert one row per seat, correct `seat_index`, no double counting for a wide submission, and unchanged singleton boards. Recording tests round-trip distinct `players` and `seats` objects, including mixed human and companion attribution, verify the materialized player count and plan key, and reject a header missing any of the three. Backend and frontend replay tests distinguish a decisive partnership winner from a true tie and render the player membership detail.

Resource tests cover the exact derived memory for one, two, and four players, including that a one-player session matches today's value exactly, plus watchdog arithmetic, season episode-limit overrides, safe-integer overflow rejection, and the unchanged live session backstop.

## Done when

A synthetic wide layout runs end to end through both live and workflow launch assembly. An agent seat stages one submission and expands it across its members. A human seat makes one player external, stages its selected companion at most once, and expands that agent across the remaining members. Each seat writes one reduced result row and appears once in standings with accurate controller attribution. Failures affect only the attributable seat when possible, container memory uses the tracked 128 MB per-additional-player default, and chargeable workflow time grows with the resolved player count while a one-player session is untouched.
