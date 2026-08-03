# Stage 15.3: Results and binding move to the seat

Status: complete.

Part of [Stage 15](../stage-15-wide-seats.md), build-order step 3.

## Outcome

The live-session and workflow paths expand each resolved seat into player bindings, while recordings and leaderboard results contain one reduced row per seat. An agent seat repeats one agent binding across its players. A wide human seat either makes every human-capable member external or makes its first human-capable member external and uses one explicitly selected companion agent for every remaining member. All current environments still resolve to singleton seats, so scores, standings, and replay labels remain behaviorally identical while the full wide-seat path becomes testable with synthetic layouts.

The hands-on check launches a fixture layout with seats of different widths. One submitted agent is staged once per seat, loaded as a separate agent instance for each player in that seat, and produces one standings row whose score is the mean of its player scores.

## Expand seat assignments into player bindings

Refactor `backend/src/session/launch-config.ts` so its input is a map of `seat_N` to `SeatBinding`, while its output is explicitly player-named:

- `SeatBinding` keeps its name and becomes genuinely one per seat. Its ordinary variants are Naive and submission. Its human variant carries the ordered player ids controlled by the person and an optional companion agent binding for any remaining members.
- `SlotConfig` becomes `PlayerConfig`, one per PettingZoo position.
- `assembleSeats` becomes `assembleLaunch`, since it now takes seats and returns players rather than working in one currency.
- The harness runtime-binding map becomes `player_bindings`, keyed by `player_N`.
- The existing recording attribution map remains named `players`, also keyed by `player_N`.

The assembly function also receives the resolved layout. For an ordinary seat it emits one player configuration and attribution entry for every member, using a separate Naive or submission instance for each. For a human seat it makes every named player external and applies the chosen companion binding to every other member. A submitted companion points those players at the same staged seat overlay path while the harness constructs separate in-process objects. No shared object or shared memory is introduced.

Which players a person controls is decided once by the orchestrator's seat validation. Self-control preserves every seat member in declared order and requires every member to occur in `human_players`. Agent-companion control keeps the first human-capable member as the only external player. That ordered choice travels on the human `SeatBinding`, so neither the external-player list nor launch assembly re-derives it. Seat validation also owns whether a seat may be human and whether a companion choice is legal, rejecting each as a request error. A companion whose binding is human needs no check: `SeatBinding.companion` is typed to the agent drivers, so the shape cannot be built. Assembly verifies that every named human player belongs to the seat and that every unmanaged member has a companion.

Return both maps as one `AssembledLaunch` value with distinct `player_bindings` and `players` fields. Reject a missing or extra seat assignment before expansion, and reject a layout that would cause the same player to be emitted twice even though metadata validation should already make that impossible.

The launch config carries no seat-to-player map. The harness already receives the environment id and the complete parameter map, and [step 1](1-split-player-from-seat.md) gives it a Python resolver, so it derives the layout itself and passes it to `Episode` and `build_header`. The layout has one source, the environment metadata, and a launch caller has no way to state a competing one.

Update both callers, `backend/src/session/orchestrator.ts` and `backend/src/workflow/workflow-runner.ts`, to resolve the layout once and pass it to launch-config assembly. The live orchestrator also passes human capability and the companion choice, then sends every controlled player id to the live session. LLM grants and keys are issued only for expanded agent-controlled `player_N` values, including companion players, and the harness continues recording per-player LLM usage before the runner reduces it.

Extend the harness `LiveConfig` parser to validate `player_bindings` and `players` against the player-id set of the layout it resolved. A binding or attribution entry naming a player outside that set is a config error.

`scripts/play.py` and the generated template local runner already emit both objects, so the only change on that path is the layout validation above. Harness and local-play fixtures exercise it directly, so adding the header field does not depend on a backend-launched container.

## Stage and attribute once per seat

Rename `CANONICAL_SUBMISSION_SLOT` and `submissionSlotPath` in `backend/src/submission/submission-image.ts` to seat vocabulary, and move the canonical constant's value from `player_0` to `seat_0`. `backend/src/submission/worker.ts` imports the constant and follows automatically. `backend/src/submission/validate/load-check.ts` hardcodes its own `player_0` literal, so point it at the shared constant and leave the staged path with one definition. The container base path `/opt/agents/submissions` is declared in the submission image builder, the load check, and the Docker overlay, so collapse those to one exported constant too: three copies of a path that must stay in lockstep is what let the suffix convention change in only some of them. Rename the remaining `slot` identifiers on this path (`SessionImageSlot.slotId`, `LoadCheckOptions.slotId`, the worker's `SLOT_ID`, and the driver overlay's `slotId` fields), since they now all carry seat ids. The live orchestrator and workflow runner resolve, build, and stage a submitted overlay once for each assigned seat, then reuse that seat path for every player driven by that submission. A submitted companion uses the human seat's path for all nonhuman members. The same submission assigned to two different seats receives two distinct seat paths and two independent groups of player instances.

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

Treat the harness `EpisodeResult.scores` map as the only source of scores. The recording writes only the acting player each tick, so a terminal-scored game reads back a stale value for everyone else and there is no per-seat fallback to it. Every resolved player must have a finite score before reduction. A missing, extra, or nonfinite player score is an unattributed game fault, not a partial result. A reported `failed_player` must name a player in the layout. An attributed player crash, illegal action, or episode-budget timeout marks only that player's seat failed. An `act` call that exceeds `step_limit_ms` keeps the existing behavior: discard the late action, apply the legal default, count and charge the overrun, and continue without marking the seat failed. A later `chat` or `learn` overrun preserves the chosen action and any validated messages, records and charges the timeout, and likewise does not mark the seat failed. An OOM, malformed result, missing result, or other fault that cannot be attributed to one player marks every seat failed.

In `workflow-runner.ts`, treat the stored `season_run_games.seats` array as one assignment per canonical seat. Zip array index 0 with `seat_0`, index 1 with `seat_1`, and so on, after validating the array's plan key and length against the layout the run resolves. Store the plan key the schedule was built from beside the assignment array, so a plan of equal seat count and different membership cannot zip silently onto the wrong players. The scheduler requires that key as an ordinary input and the column carries no default, so a caller states it rather than inheriting a fabricated `solo`. Every game in a run shares one layout and one stored plan key, so the check runs once when the run starts, before any game is marked running, and a mismatch fails the run instead of repeating as the same fault on every game. Use that seat id for image staging and `session_submissions`, then expand through the layout for player bindings, LLM grants, telemetry lookups, and reduction. Never derive `player_N` directly from a scheduled array index. A focused test uses the partnership-shaped mapping `seat_0 -> [player_0, player_2]` to pin the noncontiguous expansion.

Run seat reduction before `normalizeEpisodeScore` and before applying `forfeitScore`. Persist one `game_results` row per seat with its zero-based `seat_index`. Apply the forfeit floor only to failed seats, leaving every surviving seat's honest reduced score intact. Board aggregation and placement persistence then consume seat rows without inferring partnerships from equal player values.

## Recording and presentation

Add two required fields to `schema/recording-header.schema.json`, alongside the existing `players` attribution object:

- `seats`, keyed by `seat_N`, whose values are nonempty arrays of unique `player_N` ids forming the exact player partition.
- `seat_plan`, the resolver's canonical plan key, which is `solo` for a player-bounds environment.

Both are required, and a header missing either is malformed. Stage 15 targets a fresh pre-release checkout with no backward-compatibility path, so a recording written before this stage is an artifact that gets recreated rather than a shape the reader has to understand. Every supported recording therefore carries both, and the reader has one code path.

The player count is the size of the seat partition, so a reader derives it. `schema_version` holds at 1, because Stage 15 supports no recording written before it. Note that in the schema description.

Regenerate the TypeScript recording types and update recording fixtures. Recording validation checks `players` and `seats` independently and then their relationship: all and only attributed player ids appear once across the seats. Every fixture carries both fields.

Update `backend/src/recordings.ts::winnerId` to compare reduced seat scores and return the winning `seat_N`, grouping player scores through the header's `seats` map. Preserve the existing tie sentinel only when two or more seats share the top reduced score.

Refactor `frontend/src/lib/standings.ts`, its Game Over card consumers, and replay rows to produce one row per header seat. A row retains its seat id, ordered controller attribution, member player ids for secondary detail, and reduced score. An ordinary agent seat collapses repeated player attribution to one label. A mixed human seat shows the human followed by the companion agent. Rows are tagged with the seat id in its own short form, `S0` rather than the player's `P0`, because seats and players are numbered independently and a wide seat's number matches no member's. Singleton recordings keep their ranks and controller labels; only the row tag changes.

Two lookups feed a row and they are not interchangeable. The rank score reads the `leaderboard_scores` overlay and falls back to the player's recorded running score, while the displayed value reads `display_scores` alone and has no fallback: substituting a raw cumulative reward there would show a different quantity from the one the card promises. A seat whose members have no display score shows the rounded rank score instead. Without a header, size the rows from the overlay array rather than from `state.agents`, which on a terminal frame holds only the last acting player. One helper names a seat for both the card and the replay list, so the singleton and wide cases cannot diverge between them.

Local play needs no separate implementation. `scripts/play.py` builds and serves the frontend's local bundle, which renders `GameOverCard.vue` and therefore already consumes `standings.ts`, so seat-ranked standings reach the local runner through that one change. Three comments in `standings.ts` still point at `scripts/play.py` `_standings`, at the file header and again beside two helpers, and that function has not existed since Stage 13 moved rendering into the browser and removed the Python side. Correct all three here rather than writing a Python ranking helper to match them.

## Resource scaling

Memory and time scale differently, because one container runs a whole game and every agent is an in-process object inside a single interpreter. A second player adds an agent object, not a second runtime, so memory is a base plus a smaller increment while chargeable time is a straight multiple.

`SANDBOX_MEMORY_MB` keeps its meaning as the session base. Add `SANDBOX_MEMORY_PER_PLAYER_MB` beside it, and derive the profile before calling `buildSandboxProfile` in both the live orchestrator and workflow runner:

```text
SANDBOX_MEMORY_MB + SANDBOX_MEMORY_PER_PLAYER_MB * (resolved player count - 1)
```

Both values are operator-configurable through the ordinary environment-variable path. Set `SANDBOX_MEMORY_PER_PLAYER_MB=32` in the tracked `.env.default`, so a default four-player session receives 608 MB from the existing 512 MB base. A deployment that runs heavy agents or an unusually wide layout can tune either term without a code change. A one-player session receives exactly what it receives today, which keeps Flappy Bird and submission validation unchanged, and a wide layout grows in proportion to what it actually adds. Keep CPU and scratch limits unchanged. Submission validation still uses the base alone, because it loads one agent in isolation.

Keep the increment small. Season runs are serialized through the workflow queue and submission validation runs one at a time, but concurrent live browser sessions are bounded only by the host, so every megabyte here multiplies across them.

Add the new value to the sandbox configuration type and required integer parsing, `.env.default`, explicit config-test maps, and launch fixtures. `docs/contributors/setup/configuration.md` documents `SANDBOX_MEMORY_MB` as the session memory quota. Revise that row and add the new variable in the same change, since the quota is now a base rather than the whole allowance.

Change the workflow chargeable-wall-clock watchdog to:

```text
effective episode limit per player * resolved player count + workflow watchdog grace
```

The effective episode limit is the frozen season override when present, otherwise `EnvironmentMeta.episode_limit_ms`. The calculation uses that published value, the resolved player count, and the runner's grace directly. Every term is run-level, so derive the bound once when the run starts and pass it to each game. The per-player harness episode and step budgets remain unchanged. `SESSION_MAX_DURATION_MS` remains the fixed live-session wall-clock backstop for browser sessions, including time spent waiting for a human, and is not presented as a compute guarantee.

Keep this scaling in small pure helpers covered independently from Docker launch. The launch tests assert the exact profile and watchdog values for one-player and multi-player layouts.

## Specification edits

This step moves the result, binding, and recording contracts to the seat, so it revises:

- [Leaderboard](../../docs/specs/leaderboard.md): one episode score per seat, the reduction rules from the Stage 15 table, and forfeit scope.
- [Recording](../../docs/specs/recording.md): the seat-to-player map, mixed human and companion attribution, the materialized plan key, and the seat-ranked standings card.
- [Execution](../../docs/specs/execution.md): staging per seat, and the memory and chargeable-time scaling above.
- [Submissions](../../docs/specs/submission.md): a submission bound across a seat's players or selected as a human seat's companion.

[LLM API](../../docs/specs/llm.md) needs no edit. It already keys budgets, rate limits, and telemetry per player and sums them across a seat, which is what the reduction here implements.

Every one of these uses the word `seats` today to mean one PettingZoo position, so read each occurrence and decide which meaning it now carries instead of replacing the word.

## Tests

Launch-config and orchestrator tests cover:

- A singleton seat producing one player binding with unchanged attribution.
- A two-player seat producing two independent player configs from one staged submission path.
- Two seats assigned the same submission using distinct staged seat paths.
- A three-player human seat making only its first human-capable member external and expanding one selected companion into two distinct player configs and in-process agent objects that share only the staged seat path.
- A wide human seat making every member external when self-control is selected, with no companion binding or LLM grant.
- Rejection of a seat with no human-capable member, a self-controlled seat containing a nonhuman-capable member, a missing wide-seat companion, an unnecessary singleton companion, and a human companion binding.
- Per-player LLM keys and grants for every expanded submitted player, including companion players.
- One `session_submissions` row per seat containing a submission rather than per player.

Harness and local-play tests cover the `player_bindings` and `players` config objects, reject a binding or attribution entry naming a player outside the resolved layout, and inspect the seat map and plan key the harness derived for itself in the emitted header. A local-play test also confirms that the maintainer launcher's final standings rank seats, since `scripts/play.py` reaches them through the shared frontend bundle rather than through a Python helper of its own. The existing byte-identical recording tests keep passing unchanged.

Pure reducer tests pin:

- Means for scores and sums for compute, ticks, model usage, and weighted cost.
- `sum(compute) / sum(ticks)` matching the same per-decision mean whether two players are one seat or two singleton seats.
- Logical-or failure, and a failure reason naming the failing player.
- A one-player seat beside a three-player seat.
- An episode-budget timeout forfeiting only its seat, while a late `act` applies the default action and later-hook overruns preserve it, with neither step overrun causing a forfeit.
- Missing scores, unknown failed-player ids, malformed result envelopes, and unattributed process faults forfeiting every seat.

Storage and board tests assert one row per seat, correct `seat_index`, no double counting for a wide submission, and unchanged singleton boards. Recording tests round-trip distinct `players` and `seats` objects, including mixed human and companion attribution, verify the materialized plan key and the player count derived from the seat map, and reject a header missing either field. Backend and frontend replay tests distinguish a decisive partnership winner from a true tie and render the player membership detail.

Resource tests cover the exact derived memory for one, two, and four players, including that a one-player session matches today's value exactly, plus watchdog arithmetic, season episode-limit overrides, and the unchanged live session backstop.

## Done when

A synthetic wide layout runs end to end through both live and workflow launch assembly. An agent seat stages one submission and expands it across its members. A human seat either makes all its members external or makes one player external, stages its selected companion at most once, and expands that agent across the remaining members. Each seat writes one reduced result row and appears once in standings with accurate controller attribution. Failures affect only the attributable seat when possible, container memory uses the tracked 32 MB per-additional-player default, and chargeable workflow time grows with the resolved player count while a one-player session is untouched.
