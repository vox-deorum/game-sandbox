# Stage 15: Wide seats

Status: not started.

## Goal

A seat becomes the unit a submission is bound to, and a seat may cover more than one PettingZoo player. A seat's score is the mean of its players' scores, so one board ranks seats of any width. An environment either declares player bounds for one seat per player or declares one or more seat plans for wider layouts, and a season or a player chooses the applicable layout. Spades can then run as two seats of two players, where an operator picks two agents instead of four and one submission plays a whole partnership, and the platform stops inferring partnerships from tied scores.

Seats within a plan may be uneven, which is what lets a future role-playing environment seat one hero beside ten villagers and ten monsters.

## Scope

- The vocabulary split between a **player**, one PettingZoo position with id `player_N`, and a **seat**, the assignable unit with id `seat_N` that covers one or more players.
- A `seat_plans` environment metadata field, where each plan names the players every one of its seats covers, as the alternative to declaring player bounds, plus a reserved synthesized `seat_plan` choice parameter and the derived player and seat counts.
- The renames the split forces at the platform level: the reserved `seats` parameter becomes `players`, and `min_slots`, `max_slots`, and `human_slots` become `min_players`, `max_players`, and `human_players`.
- The matching rename inside the environments, their student guides, and the shared card renderer, where "seat" currently means a table position and "slot" means a PettingZoo agent id.
- One shared seat-plan resolution per language, and one `game_results` row per seat with the reduction rules below.
- The seat-to-player map in the recording header, submission staging per seat, seat-ranked standings, and the replay result label.
- Spades declaring a partnership plan and a solo plan, its renderer marking the partnerships, and the seat grid, standings detail, and human-play rule that follow.
- The contributor guides that mirror the metadata names, which are `docs/contributors/environments/package.md`, `docs/contributors/environments/template-and-examples.md`, and `docs/contributors/testing/browser-e2e.md`.

Stage 15 targets a fresh, pre-release checkout, exactly as Stage 14 did. It updates the current source, version 1 template contents, and the flat initial database schema in place. `template_version` and `deps_version` stay at 1 even though the student-facing helper names change, because no deployed submission needs to keep working. Databases, built session images, and composed templates from another checkout are unsupported and must be recreated. There is no data migration or backward-compatibility path.

Out of scope: the role-playing or tactical environment itself, which is designed separately and needs nothing from the platform beyond this stage; a team leaderboard or any persisted team of submissions; one agent object with shared memory across several players; pairing policies, sampling, and rotation engines; a seat covering players of two different plans; and two submissions cooperating inside one seat.

## Related specifications

- [Environments](../docs/specs/environment.md): player and seat, player bounds and seat plans, the `players` and `seat_plan` parameters, and the derived player and seat counts.
- [Leaderboard](../docs/specs/leaderboard.md): one episode score per seat, the reduction rules, forfeit scope, and match design over seats.
- [Interaction](../docs/specs/interaction.md): grid sizing from the resolved seat layout, and a human occupying a seat.
- [Frontend](../docs/specs/frontend.md): the seat grid, standings, replay label, and season config editor.
- [Recording](../docs/specs/recording.md): the seat-to-player map in the header and the seat-ranked standings card.
- [Execution](../docs/specs/execution.md): staging per seat and quotas scaling with the player count.
- [Submissions](../docs/specs/submission.md): a submission bound to a seat covering several players.
- [LLM API](../docs/specs/llm.md): budgets and telemetry keyed per player.

## Depends on

- [Stage 2](stage-02-harness-and-first-environment.md): environment metadata and the entry-point registry.
- [Stage 6](stage-06-leaderboards.md): seasons, season config, the scheduler, and automated runs.
- [Stage 7](stage-07-multi-agent.md): multi-seat sessions and the slots start API.
- [Stage 8](stage-08-communication.md): Spades and the chat hook.
- [Stage 13](stage-13-unified-rendering.md): the shared card renderer this stage renames through.
- [Stage 14](stage-14-environment-variants.md): the typed parameter declarations and the reserved-parameter pattern this stage extends.

## Design decisions

### An environment describes its seats in one of two ways, never both

`EnvironmentMeta` keeps `min_players` and `max_players` for the common case and gains `seat_plans` for the rest. An environment declares one or the other, and one that declares both fails to load.

With **player bounds**, every player gets a seat of its own. That is the canonical `solo` plan, and the player count stays an ordinary gameplay parameter that may vary within the bounds. Flappy Bird and Hearts stay here and declare nothing new. This is the path a future variable-player environment takes.

With **seat plans**, an ordered tuple, each plan has a snake_case key, a friendly title, and its seats, where a seat is the tuple of player indices it covers. The player count is derived from the chosen plan rather than declared beside it. That is what makes a static plan and a free-floating player count unrepresentable rather than merely discouraged: there is no separate count for a plan to contradict. Every seat must be nonempty, and the plan's indices must form the exact zero-based range from `0` through `N - 1`, where `N` is the number of distinct players in the plan, with each index occurring once. This is validated when an environment is loaded rather than when a session starts. Plans in one environment need not cover the same number of players, so an environment that wants several player counts declares one plan per count.

Naming the players of each seat, rather than deriving them from a layout rule, is what lets one declaration express both a partnership seated across the table and an uneven cast of characters. Spades declares `partnership`, whose seats are `(0, 2)` and `(1, 3)`, and `solo`, whose four seats hold one player each. A role-playing environment declares a plan of `(0,)`, `(1..10)`, and `(11..20)`. Nothing needs a divisibility rule, an interleaved-versus-contiguous enum, or a per-seat width parameter, because the plan says exactly which players belong where.

`solo` is the canonical key for one seat per player, whether it arrives implicitly under player bounds or is declared outright as Spades declares it. Every consumer that persists or displays a plan therefore has a value to use, including an environment that never declares a plan at all.

### Exactly one reserved parameter, matching the declaration

An environment with player bounds gets the `players` integer parameter, bounded by `min_players` and `max_players` and defaulting to `max_players`. That is the Stage 14 `seats` parameter under its new name, unchanged in behavior.

An environment with declared plans gets the `seat_plan` choice parameter instead, whose values are the plan keys and whose labels are their titles, defaulting to the first declared plan. It follows the pattern Stage 14 established for reserved parameters. An environment with one plan has a one-option choice, which the website already hides.

The player count and the seat count are always derived, never declared. Under player bounds both equal the resolved `players` value. Under declared plans both come from the resolved plan. The environment factory reads whichever reserved parameter it has and sizes `possible_agents` accordingly, and `Episode.start()` asserts against the derived player count either way.

Spades declares the partnership plan first, so it is the default. The solo plan is the configuration that cannot actually be run at class scale, since its P(20,4) = 116,280 seatings plus the appended all-Naive assignment produce 232,562 sequential container runs at a roster of 20 with `games: 2`, against P(20,2) = 380 seatings plus that assignment and 762 runs for the partnership plan. A default that cannot be run is a trap, so the runnable plan is the default and the solo plan is a deliberate choice.

### A seat's score is the mean of its players' scores

The environment keeps reporting one score per player through `EpisodeResult.scores`, and the platform reduces those to one value per seat. How player scores relate is the environment's business. Spades gives both partners the partnership score, so their mean is the partnership score. An environment that scores each unit on its own contribution gives a seat the average of its units.

The mean rather than the sum, because a mean is comparable across seat widths. That matters within a single game once seats are uneven, since a one-player hero seat and a ten-player villager seat appear in the same standings. The reduction runs before normalization and before the forfeit floor, so `normalizeEpisodeScore` and `forfeitScore` in `backend/src/leaderboards/score.ts` keep operating on one value per scored entity.

### Limits stay per player, resources sum, the score averages

| Quantity | Enforced or measured at | Reduction to the seat |
| --- | --- | --- |
| `step_limit_ms` | per player, per `act` call | none, enforced where it is measured |
| `episode_limit_ms` | per player | none, enforced where it is measured |
| LLM token budget and rate limit | per player | none, one meter per player |
| `human_timeout_ms` | per turn | none, a human seat takes one clock on each of its players' turns |
| `episode_score` | per player | mean |
| `agent_compute_ms_total` | per player | sum |
| `acted_tick_count` | per player | sum |
| `llm_usage_by_model`, `llm_weighted_cost` | per player | sum |
| `failed` | per player | any |
| `failure_reason` | per player | the failing player's, naming that player |

Enforcement stays per player because a wide seat makes proportionally more decisions. A Spades submission covering two positions faces the same number of turns per position as a Hearts submission covering one, so pooling one episode budget across a seat would starve wide seats for no principled reason. The same argument applies to the LLM meters, and it matters more once seats are uneven, since a pooled budget would punish the ten-villager seat for being large.

Resources sum while the score averages because they are different kinds of quantity. A score is a performance level and must be width-independent, whereas compute time and tokens are totals. This falls out well for the board's efficiency column, which is already mean compute per decision weighted by acted ticks: `sum(ms) / sum(ticks)` stays a correct per-decision mean at any width, so `getAutomatedBoard` in `backend/src/storage/kysely/boards.ts` needs no change beyond reading seat rows.

Total agent compute in one game is bounded by the player count times the episode budget, not the seat count times the episode budget, so the container watchdog, the workflow's per-game timeout, and container memory all scale with players.

### The platform rename

Once a seat is the wider thing, the reserved `seats` parameter and the `*_slots` metadata fields name the narrower thing, so their names invert. The reserved parameter `seats` becomes `players` with its meaning, bounds, and the `Episode.start()` assertion against `len(env.possible_agents)` unchanged. `min_slots`, `max_slots`, and `human_slots` become `min_players`, `max_players`, and `human_players`. Seat ids are `seat_N`, and position ids stay `player_N`.

The harness's `Slot` family names a PettingZoo position and therefore becomes player-named: `AgentSlot`, `ExternalSlot`, `Slot`, `SlotBinding`, `_SlotState`, `slot_id` throughout `session.py` and `live.py`, `EpisodeResult.failed_slot`, the `slots` mapping and its JSON config key, and `default_action(env, slot_id)`. The backend follows in the four places that independently derive `player_${i}` today, `frontend/src/components/SeatAssignmentDialog.vue`, `validateSlotShape` in `backend/src/session/orchestrator.ts`, `backend/src/workflow/workflow-runner.ts`, and `submissionSlotPath` in `backend/src/submission/submission-image.ts`, plus the `^player_[0-9]+$` pattern in `backend/src/app.ts`, and the `players` and per-position descriptions in the recording and step-state JSON schemas.

The storage layer carries the same overloaded word, and the pre-release schema is being recreated anyway, so it moves in the same pass rather than leaving future debugging to work out which "slot" was meant. `game_results.slot_index` becomes `seat_index`, `session_submissions.slot_id` becomes `seat_id`, and `season_run_games.slots` becomes `seats`. The season config follows, with `MatchConfig.slots` becoming `seats` and `SlotSpec` and `SLOT_SPECS` becoming `SeatSpec` and `SEAT_SPECS`. In the session path, `SlotAssignment` becomes `SeatAssignment`, `validateSlotShape` becomes `validateSeatShape`, `MAX_HUMAN_SLOTS` becomes `MAX_HUMAN_SEATS`, and `CANONICAL_SUBMISSION_SLOT` and `submissionSlotPath` become seat-named because staging is now per seat. `backend/src/session/launch-config.ts` goes the other way: its `SeatBinding`, `SlotConfig`, and `assembleSeats` all describe individual positions today, so they become player-named and gain a seat-to-player map beside them.

### The environment rename

The environments use "seat" for a table position, which now collides with the platform's seat. All three environments, their templates, examples, guides, and tests move to player language. There is no backward compatibility to preserve, so this is one mechanical pass.

- Student helpers: `my_seat` in both `environments/hearts/template/sandbox/cards.py` and `environments/spades/template/sandbox/cards.py` becomes `my_player`; Spades' `partner_seat` becomes `partner_player` and `partner_of(seat)` becomes `partner_of(player)`. Their `__all__` entries follow.
- Observation fields: the `seat` key in both card environments becomes `player`, Spades' `partner_seat` becomes `partner_player`, and the shared `TRICK` space entry key in `environments/local_play/card_spaces.py` becomes `player`, with `NUM_SEATS` becoming `NUM_PLAYERS`.
- Overlay fields: the `current_trick` and `last_trick` entry key becomes `player` in both `overlay.py` files, and `turn_slot` becomes `turn_player`.
- Rules and environment code: the `seat` parameters and locals across `hearts/rules.py` and `spades/rules.py`, including `team_of`, `team_seats`, `legal_moves`, `legal_bids`, `legal_plays`, `legal_actions`, `is_legal_action`, `resolve_auto_action`, `lowest_legal_card`, and `leaderboard_scores`, plus the `_seat` and `_agent` helpers in both `env.py` files.
- Student guides: `environments/hearts/environment.md` and `environments/spades/environment.md`, which use the word 39 and 67 times respectively, including the "How seat numbers work" section and the partnership explanation. Flappy Bird's guide never uses it.
- Local play: the `--seat` flag and `possible_slots` in `scripts/play.py`, and the copies of that pattern in `templates/base/sandbox/play.py` and `templates/base/sandbox/evaluate.py` that back the `python -m sandbox play` command the template READMEs document.

The shared card renderer at `frontend/src/renderers/cards/scene.ts` needs care, because it carries three meanings of these two words. `SceneSeatBase.seat` and `ViewContext.viewSeat` and `controlledSeat` are table positions and become player-named. `CardOverlay.turnSlot` and `seatOfSlot` handle the `player_N` agent id and become player-named. `SceneSeatBase.slot` is neither: it is the screen position `0=South, 1=West, 2=North, 3=East` produced by `slotOfSeat`, and it needs a name of its own `position`, so the rename does not merge two distinct ideas. `environments/hearts/renderer/` and `environments/spades/renderer/` follow, along with their scene tests.

### Interface decisions

Settled with the owner before implementation.

- **Seat grid.** One agent control per seat, with a short hint in the same row after the dropdown giving the number of players the seat covers, such as "2 agents". Positions are not listed, so the row reads the same for a seat of two and a seat of ten. Because a plan may be uneven, the hint can differ from row to row.
- **Final standings and replay list.** Rows rank seats. Each row leads with the agent's label, the blind numbered label while a play window is open, and shows the players it covered as secondary detail.
- **Human play.** A human occupying a seat controls every player in it and takes a move clock on each of those players' turns. A seat is offered to a human only when every player it covers is human-capable, since taking it means driving all of them. `human_timeout_ms` is unchanged, so a human Spades session on the partnership plan runs longer than one on the solo plan. One human per session still holds, under the renamed `MAX_HUMAN_SEATS`.
- **Chat.** A human composes a message only while one of their seat's players is the acting player, and that player is the sender. The panel disables its input at every other moment. This keeps the sender unambiguous for a wide seat without adding a selector control, and it mirrors the agent `chat` hook, which already fires on the agent's own turn. Composing therefore shares the move clock with deciding, and the rule assumes turn-based pacing, which is the only mode a messaging environment uses today.
- **Spades renderer.** The table marks the partnerships, so a viewer can see that two positions belong to one seat. A renderer owns its game's visual identity, so this stays inside `environments/spades/renderer/`.

Every one of these touches existing UI, so the jsdom unit tests under `frontend/test/` and the Playwright journeys under `frontend/e2e/` that assert on the seat dialog, the standings card, and the replay list are revised in the same change set.

### Three defects this closes

All three follow from the platform ranking players when it should rank seats.

1. `winnerId` in `backend/src/recordings.ts` takes the maximum of `leaderboard_scores` and returns the `-1` tie sentinel when more than one position holds it. Both Spades partners always share the winning score, so every decisive Spades replay is labelled "Tied" today, and `docs/specs/frontend.md` documents that as intended. Ranking seats resolves it on the partnership plan. On the solo plan the label reports what the environment's own scores say, which is the environment's alignment choice rather than a platform defect.
2. `backend/src/workflow/workflow-runner.ts` marks only the culprit slot failed, so a crashing Spades agent takes the -260 floor while its honest partner and both opponents keep whatever `hand_team_scores` projected mid hand, a projection often near zero and therefore better than most honest outcomes. `backend/src/leaderboards/score.ts` already documents the floor as a partnership's worst score, so the floor and its attribution disagree. Charging the seat resolves it whenever the partnership is one seat.
3. `frontend/src/lib/standings.ts` uses dense ranking specifically so a Spades partnership shows two matching golds and two matching silvers, which means two opposing positions that happen to tie render identically to a partnership. Ranking seats removes the inference.

## Steps

### 15.1 Split player from seat

The platform rename, including the storage columns and the session path, the `seat_plans` metadata field with its load-time checks, the `seat_plan` reserved choice parameter beside the renamed `players` one, the derived player and seat counts, one shared plan resolution per language, the TypeScript shape guard, and the regenerated registry JSON. Every environment stays on player bounds and the canonical `solo` plan, so nothing changes behaviorally.

### 15.2 Results and binding move to the seat

The mean reduction in the runner, one `game_results` row per seat keyed by the renamed `seat_index`, forfeits charged to the seat after the reduction, the seat-to-player map in the recording header, submission staging per seat, `frontend/src/lib/standings.ts` and its Python twin in `scripts/play.py` ranking seats, and `winnerId` reporting the winning seat. Every environment is still one player per seat, so this prepares the result and binding changes that close the three Spades defects when Stage 15.4 adopts the partnership topology. This step also implements player-count scaling for container memory and the container watchdog and workflow per-game limits.

### 15.3 The environment rename

The mechanical pass across the three environments, their templates, examples, guides, local play, the shared card renderer, and every test that asserts on the old names. This lands on its own so the diff stays reviewable and so a failure here cannot be confused with a failure in the model above it.

### 15.4 Spades gains the partnership plan

Spades declares its two seat plans with the partnership plan first, and a test pins the partnership seats against `spades.rules.team_of`. Adopting the partnership topology closes the three Spades defects. The four interface decisions land here, along with the projected game count in the season config editor.

## Exit criteria

- `uv run python scripts/ci.py python` and `uv run python scripts/ci.py generated-code-fresh` pass, so the registry JSON matches the metadata.
- `uv run python scripts/ci.py docs` passes after the specification and guide edits.
- Loading an environment whose declared plan has an empty seat, misses a player, starts at a nonzero index, has a gap, or gives one to two seats fails with a typed error naming the plan. So does loading one that declares both player bounds and seat plans.
- An environment with declared plans sizes `possible_agents` from the resolved plan, and `Episode.start()` asserts against the derived player count in both declaration styles.
- A season config or start form that names an unknown seat plan is rejected as an ordinary invalid parameter value.
- A seat containing any player that is not human-capable is never offered to a human, and a session that assigns a human to one is refused.
- The chat input is disabled whenever no player of the human's seat is acting, and a message sent on a turn records that acting player as its sender.
- One reduction test pins the whole table: score means, compute time and acted ticks and LLM usage sum, `failed` is a logical or, and `sum(ms) / sum(ticks)` is unchanged when a seat of two players is compared against two seats of one.
- A test covers an uneven plan, where a one-player seat and a three-player seat appear in the same game and each reports one score.
- A player exceeding `step_limit_ms` or `episode_limit_ms` fails only its own seat, and the surviving seats keep their honest scores.
- The partnership plan expands to P(N,2) seatings with the Naive baseline row still appended, and a one-player-per-seat environment produces today's schedule unchanged.
- A Spades submission's board row on the partnership plan shows one game per game played rather than double-counting its two positions.
- No occurrence of `my_seat`, `partner_seat`, `min_slots`, `max_slots`, `human_slots`, or the reserved `seats` parameter remains in active implementation, schemas, templates, or current public and contributor documentation. Plan migration explanations and historical plans are excluded. The word `slot` is gone from the storage schema and the session path, and the shared card renderer's screen-position field is named `position`.
- `uv run python scripts/play.py --env spades` runs locally on both plans, and `uv run python scripts/ci.py frontend-e2e` passes after the seat dialog, standings, and replay-label changes.
- A Spades season runs end to end on each plan through the admin console, the projected game counts match the figures above, the partnership replay list shows a winner rather than "Tied", and a human session on each plan shows the seat-grid hint, the standings detail, and the renderer's partnership marking.
