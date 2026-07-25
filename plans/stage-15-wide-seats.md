# Stage 15: Wide seats

Status: not started.

## Goal

A seat becomes the unit a submission is bound to, and a seat may cover more than one PettingZoo player. A seat's score is the mean of its players' scores, so one board ranks seats of any width. An environment either declares player bounds for one seat per player or declares one or more seat plans for wider layouts, and a season or a player chooses the applicable layout. Spades can then run as two seats of two players, where an operator picks two agents instead of four and one submission plays a whole partnership. In human play, the person controls the first human-capable member of the selected seat and explicitly chooses one companion agent for its remaining members. The platform stops inferring partnerships from tied scores.

Seats within a plan may be uneven, which is what lets a future role-playing environment seat one hero beside ten villagers and ten monsters.

## Scope

- The vocabulary split between a **player**, one PettingZoo position with id `player_N`, and a **seat**, the assignable unit with id `seat_N` that covers one or more players.
- A tagged `layout` field on the environment metadata, carrying either player bounds or a tuple of seat plans, where each plan names the players every one of its seats covers, plus a reserved synthesized `seat_plan` choice parameter and the derived player and seat counts.
- The renames the split forces at the platform level: the reserved `seats` parameter becomes `players`, `min_slots` and `max_slots` move inside the layout field, and `human_slots` becomes `human_players`.
- The matching rename inside the environments, their student guides, and the shared card renderer, where "seat" currently means a table position and "slot" means a PettingZoo agent id.
- One shared seat-plan resolution per language, and one `game_results` row per seat with the reduction rules below.
- The seat-to-player map in the recording header, submission staging per seat, seat-ranked standings, and the replay result label.
- Spades declaring a partnership plan and a solo plan, its renderer marking the partnerships, a human-plus-companion assignment for a wide seat, dynamic chat recipients, and the seat grid and standings detail that follow.
- The contributor guides that mirror the metadata names, the local-play flags, or the sandbox resource variables, which are `docs/contributors/environments/package.md`, `docs/contributors/environments/template-and-examples.md`, `docs/contributors/environments/index.md`, `docs/contributors/testing/browser-e2e.md`, and `docs/contributors/setup/configuration.md`.

Stage 15 targets a fresh, pre-release checkout, exactly as Stage 14 did. It updates the current source, version 1 template contents, and the flat initial database schema in place. `template_version` and `deps_version` stay at 1 even though the student-facing helper names change, because no deployed submission needs to keep working. Databases, built session images, and composed templates from another checkout are unsupported and must be recreated. There is no data migration or backward-compatibility path.

Out of scope: the role-playing or tactical environment itself, which is designed separately and needs nothing from the platform beyond this stage; a team leaderboard or any persisted team of submissions; one agent object with shared memory across several players; pairing policies, sampling, and rotation engines; a seat covering players of two different plans; and two submissions cooperating inside one seat.

## Related specifications

- [Environments](../docs/specs/environment.md): player and seat, player bounds and seat plans, the `players` and `seat_plan` parameters, and the derived player and seat counts.
- [Leaderboard](../docs/specs/leaderboard.md): one episode score per seat, the reduction rules, forfeit scope, and match design over seats.
- [Interaction](../docs/specs/interaction.md): grid sizing from the resolved seat layout, one human player, and the companion agent for the rest of a wide seat.
- [Communication](../docs/specs/communication.md): acting-player enforcement, environment-selected direct recipients, and broadcast.
- [Frontend](../docs/specs/frontend.md): the seat grid, standings, replay label, and season config editor.
- [Recording](../docs/specs/recording.md): the seat-to-player map in the header and the seat-ranked standings card.
- [Execution](../docs/specs/execution.md): staging per seat and quotas scaling with the player count.
- [Submissions](../docs/specs/submission.md): a submission bound to a seat covering several players.
- [LLM API](../docs/specs/llm.md): budgets and telemetry keyed per player.

The specifications describe the intended system, so this stage's design edits land with the plan rather than after the code. Each step still owns the files it names and revises them again whenever implementation changes the intent. `uv run python scripts/ci.py docs` only runs `mkdocs build --strict`, so it catches a broken link and not stale prose.

## Depends on

- [Stage 2](stage-02-harness-and-first-environment.md): environment metadata and the entry-point registry.
- [Stage 6](stage-06-leaderboards.md): seasons, season config, the scheduler, and automated runs.
- [Stage 7](stage-07-multi-agent.md): multi-seat sessions and the slots start API.
- [Stage 8](stage-08-communication.md): Spades and the chat hook.
- [Stage 13](stage-13-unified-rendering.md): the shared card renderer this stage renames through.
- [Stage 14](stage-14-environment-variants.md): the typed parameter declarations and the reserved-parameter pattern this stage extends.

## Design decisions

### An environment describes its seats in one of two ways, never both

`EnvironmentMeta` carries one tagged `layout` value with two variants: **player bounds** for the common case and **seat plans** for the rest. The tag is the declaration style, so an environment cannot supply both or neither. That is a shape typed construction rules out rather than a rule a validator enforces in ordinary source, and it travels unchanged to the generated JSON and to the TypeScript union.

With **player bounds**, the variant holds `min` and `max`, and every player gets a seat of its own. That is the canonical `solo` plan, and the player count stays an ordinary gameplay parameter that may vary within the bounds. Flappy Bird and Hearts stay here and declare nothing new. This is the path a future variable-player environment takes.

With **seat plans**, an ordered tuple, each plan has a snake_case key, a friendly title, and its seats, where a seat is the tuple of player indices it covers. The player count is derived from the chosen plan rather than declared beside it. That is what makes a static plan and a free-floating player count unrepresentable rather than merely discouraged: there is no separate count for a plan to contradict. Every seat must be nonempty, and the plan's indices must form the exact zero-based range from `0` through `N - 1`, where `N` is the number of distinct players in the plan, with each index occurring once. This is validated when an environment is loaded rather than when a session starts. Plans in one environment need not cover the same number of players, so an environment that wants several player counts declares one plan per count.

Naming the players of each seat, rather than deriving them from a layout rule, is what lets one declaration express both a partnership seated across the table and an uneven cast of characters. Spades declares `partnership`, whose seats are `(0, 2)` and `(1, 3)`, and `solo`, whose four seats hold one player each. A role-playing environment declares a plan of `(0,)`, `(1..10)`, and `(11..20)`. Nothing needs a divisibility rule, an interleaved-versus-contiguous enum, or a per-seat width parameter, because the plan says exactly which players belong where.

`solo` is the canonical key for one seat per player, whether it arrives implicitly under player bounds or is declared outright as Spades declares it. Every consumer that persists or displays a plan therefore has a value to use, including an environment that never declares a plan at all.

### Exactly one reserved parameter, matching the declaration

An environment with player bounds gets the `players` integer parameter, bounded by the variant's `min` and `max` and defaulting to `max`. That is the Stage 14 `seats` parameter under its new name, unchanged in behavior.

An environment with declared plans gets the `seat_plan` choice parameter instead, whose values are the plan keys and whose labels are their titles, defaulting to the first declared plan. It follows the pattern Stage 14 established for reserved parameters. An environment with one plan has a one-option choice, which the website already hides.

The player count and the seat count are always derived, never declared. Under player bounds both equal the resolved `players` value. Under declared plans both come from the resolved plan. The environment factory reads whichever reserved parameter it has and sizes `possible_agents` accordingly, and `Episode.start()` asserts against the derived player count either way.

Spades declares the partnership plan first, so it is the default. The solo plan is the configuration that cannot actually be run at class scale, since its P(20,4) = 116,280 seatings plus the appended all-Naive assignment produce 232,562 sequential container runs at a roster of 20 with `games: 2`, against P(20,2) = 380 seatings plus that assignment and 762 runs for the partnership plan. A default that cannot be run is a trap, so the runnable plan is the default and the solo plan is a deliberate choice.

### A seat's score is the mean of its players' scores

The environment keeps reporting one score per player through `EpisodeResult.scores`, and the platform reduces those to one value per seat. How player scores relate is the environment's business. Spades gives both partners the partnership score, so their mean is the partnership score. An environment that scores each unit on its own contribution gives a seat the average of its units.

The mean rather than the sum, because a mean is comparable across seat widths. That matters within a single game once seats are uneven, since a one-player hero seat and a ten-player villager seat appear in the same standings. The reduction runs before normalization and before the forfeit floor, so `normalizeEpisodeScore` and `forfeitScore` in `backend/src/leaderboards/score.ts` keep operating on one value per scored entity.

### Limits stay per player, resources sum, the score averages

| Quantity | Enforced or measured at | Reduction to the seat |
| --- | --- | --- |
| `step_limit_ms` | per player, per turn | none; a late `act` defaults, while later hook overruns preserve the action |
| `episode_limit_ms` | per player | none, enforced where it is measured |
| LLM token budget and rate limit | per player | none, one meter per player |
| `human_timeout_ms` | per turn | none, used only when the designated human player acts |
| `episode_score` | per player | mean |
| `agent_compute_ms_total` | per player | sum |
| `acted_tick_count` | per player | sum |
| `llm_usage_by_model`, `llm_weighted_cost` | per player | sum |
| `failed` | per player | any |
| `failure_reason` | per player | the failing player's, naming that player |

Enforcement stays per player because a wide seat makes proportionally more decisions. A Spades submission covering two positions faces the same number of turns per position as a Hearts submission covering one, so pooling one episode budget across a seat would starve wide seats for no principled reason. The same argument applies to the LLM meters, and it matters more once seats are uneven, since a pooled budget would punish the ten-villager seat for being large.

Resources sum while the score averages because they are different kinds of quantity. A score is a performance level and must be width-independent, whereas compute time and tokens are totals. This falls out well for the board's efficiency column, which is already mean compute per decision weighted by acted ticks: `sum(ms) / sum(ticks)` stays a correct per-decision mean at any width, so `getAutomatedBoard` in `backend/src/storage/kysely/boards.ts` needs no change beyond reading seat rows.

Total agent compute in one game is bounded by the player count times the episode budget, not the seat count times the episode budget, so the container watchdog and the workflow's per-game timeout scale with players.

Container memory scales with players too, but not by the same arithmetic. One container runs the whole game and every agent is an in-process object inside one interpreter, so a second player adds an agent object rather than a second runtime. Memory is therefore a session base plus a smaller per-player increment, with both values operator-configurable, which leaves a one-player session exactly as it is today and grows a wide one in proportion to what it actually adds.

### The platform rename

Once a seat is the wider thing, the reserved `seats` parameter and the `*_slots` metadata fields name the narrower thing, so their names invert. The reserved parameter `seats` becomes `players` with its meaning, bounds, and the `Episode.start()` assertion against `len(env.possible_agents)` unchanged. `min_slots` and `max_slots` become the `min` and `max` of the player-bounds layout variant. `human_slots` becomes `human_players` and stays a top-level field, because human capability is a property of a player rather than of a declaration style. A seat is human-playable when it contains at least one such player, and the first human-capable member in declared seat order becomes the human player. Seat ids are `seat_N`, and position ids stay `player_N`.

The harness's `Slot` family names a PettingZoo position and therefore becomes player-named: `AgentSlot`, `ExternalSlot`, `Slot`, `SlotBinding`, `_SlotState`, `slot_id` throughout `session.py` and `live.py`, `EpisodeResult.failed_slot`, the `slots` mapping and its JSON config key, and `default_action(env, slot_id)`. The backend follows in the four places that independently derive `player_${i}` today, `frontend/src/components/SeatAssignmentDialog.vue`, `validateSlotShape` in `backend/src/session/orchestrator.ts`, `backend/src/workflow/workflow-runner.ts`, and `submissionSlotPath` in `backend/src/submission/submission-image.ts`, plus the `^player_[0-9]+$` pattern in `backend/src/app.ts`, and the `players` and per-position descriptions in the recording and step-state JSON schemas.

The storage layer carries the same overloaded word, and the pre-release schema is being recreated anyway, so it moves in the same pass rather than leaving future debugging to work out which "slot" was meant. `game_results.slot_index` becomes `seat_index`, `session_submissions.slot_id` becomes `seat_id`, and `season_run_games.slots` becomes `seats`. The season config follows, with `MatchConfig.slots` becoming `seats` and `SlotSpec` and `SLOT_SPECS` becoming `SeatSpec` and `SEAT_SPECS`. In the session path, `SlotAssignment` becomes `SeatAssignment`, `validateSlotShape` becomes `validateSeatShape`, `MAX_HUMAN_SLOTS` becomes `MAX_HUMAN_PLAYERS`, and `CANONICAL_SUBMISSION_SLOT` and `submissionSlotPath` become seat-named because staging is now per seat, with the canonical constant's value moving from `player_0` to `seat_0`. `SeatAssignment` is a composite human assignment when needed: it identifies the human choice and carries the companion agent selected for the other members. `backend/src/session/launch-config.ts` splits along the same line instead of moving wholesale. Its input is what an operator assigned, so `SeatBinding` keeps its name and becomes genuinely one per seat. Its output is what the harness runs, so `SlotConfig` becomes `PlayerConfig` and `assembleSeats` becomes `assembleLaunch`, the function that expands seat assignments into player configurations. `backend/src/workflow/aggregate.ts` moves the other way for the same reason: `aggregateSeat` and `SeatAggregate` summarize one PettingZoo position today, so they become `aggregatePlayer` and `PlayerAggregate` and leave the seat name free for the reduction that follows them.

### The environment rename

The environments use "seat" for a table position, which now collides with the platform's seat. All three environments, their templates, examples, guides, and tests move to player language. There is no backward compatibility to preserve, so this is one mechanical pass.

- Student helpers: `my_seat` in both `environments/hearts/template/sandbox/cards.py` and `environments/spades/template/sandbox/cards.py` becomes `my_player`; Spades' `partner_seat` becomes `partner_player` and `partner_of(seat)` becomes `partner_of(player)`. Their `__all__` entries follow.
- Observation fields: the `seat` key in both card environments becomes `player`, Spades' `partner_seat` becomes `partner_player`, and the shared `TRICK` space entry key in `environments/local_play/card_spaces.py` becomes `player`, with `NUM_SEATS` becoming `NUM_PLAYERS`.
- Overlay fields: the `current_trick` and `last_trick` entry key becomes `player` in both `overlay.py` files, and `turn_slot` becomes `turn_player`.
- Rules and environment code: the `seat` parameters and locals across `hearts/rules.py` and `spades/rules.py`, including `team_of`, `team_seats`, `legal_moves`, `legal_bids`, `legal_plays`, `legal_actions`, `is_legal_action`, `resolve_auto_action`, `lowest_legal_card`, and `leaderboard_scores`, plus the `_seat` and `_agent` helpers in both `env.py` files.
- Student guides: `environments/hearts/environment.md` and `environments/spades/environment.md`, which use the word 39 and 67 times respectively, including the "How seat numbers work" section and the partnership explanation. Flappy Bird's guide never uses it.
- Local play: player-shaped `possible_slots`, bindings, and helper arguments in `scripts/play.py`, `templates/base/sandbox/play.py`, and `templates/base/sandbox/evaluate.py`. The maintainer launcher's `--seat` remains the seat-assignment selector and resolves through the chosen layout.

The shared card renderer at `frontend/src/renderers/cards/scene.ts` needs care, because it carries three meanings of these two words. `SceneSeatBase.seat` and `ViewContext.viewSeat` and `controlledSeat` are table positions and become player-named. `CardOverlay.turnSlot` and `seatOfSlot` handle the `player_N` agent id and become player-named. `SceneSeatBase.slot` is neither: it is the screen position `0=South, 1=West, 2=North, 3=East` produced by `slotOfSeat`, and it needs a name of its own `position`, so the rename does not merge two distinct ideas. `environments/hearts/renderer/` and `environments/spades/renderer/` follow, along with their scene tests.

### Interface decisions

Settled with the owner before implementation.

- **Seat grid.** One assignment control per seat, with a short hint in the same row giving the number of players the seat covers, such as "2 players". Positions are not listed. Selecting Human on a wide seat reveals one required Companion agent control, populated from the ordinary built-in and submission choices. The user makes that choice explicitly before starting.
- **Final standings and replay list.** Rows rank seats. Each row leads with the seat's controller attribution, uses blind numbered labels while a play window is open, and shows the players it covered as secondary detail. A mixed human seat shows the human and companion.
- **Human play.** A human assignment controls the first human-capable member in the seat's declared order. One selected companion agent is instantiated separately for every other member. Only the human player's turns use `human_timeout_ms`. One human player per session still holds, under the renamed `MAX_HUMAN_PLAYERS`.
- **Chat.** The environment may derive ordered direct-recipient choices and a default from live game state. Broadcast remains available in every messaging environment. The harness, not the browser, enforces the sender, the tick, and the current policy for human messages, and applies the same recipient policy to agent output. An invalid message is dropped with a diagnostic rather than charged as an illegal move.
- **Spades renderer.** The table marks the partnerships, so a viewer can see that two positions belong to one seat. A renderer owns its game's visual identity, so this stays inside `environments/spades/renderer/`.

Every one of these touches existing UI, so the jsdom unit tests under `frontend/test/` and the Playwright journeys under `frontend/e2e/` that assert on the seat dialog, the standings card, and the replay list are revised in the same change set.

### Three defects this closes

All three follow from the platform ranking players when it should rank seats.

1. `winnerId` in `backend/src/recordings.ts` takes the maximum of `leaderboard_scores` and returns the `-1` tie sentinel when more than one position holds it. Both Spades partners always share the winning score, so every decisive Spades replay is labelled "Tied" today. `docs/specs/frontend.md` already states the rule in seat terms, so ranking seats resolves it on the partnership plan with no wording change: the sentence becomes true once a seat is the wider unit, and a genuine tie between two opposing seats still earns the label. On the solo plan the label reports what the environment's own scores say, which is the environment's alignment choice rather than a platform defect.
2. `backend/src/workflow/workflow-runner.ts` marks only the culprit slot failed, so a crashing Spades agent takes the -260 floor while its honest partner and both opponents keep whatever `hand_team_scores` projected mid hand, a projection often near zero and therefore better than most honest outcomes. `backend/src/leaderboards/score.ts` already documents the floor as a partnership's worst score, so the floor and its attribution disagree. Charging the seat resolves it whenever the partnership is one seat.
3. `frontend/src/lib/standings.ts` uses dense ranking specifically so a Spades partnership shows two matching golds and two matching silvers, which means two opposing positions that happen to tie render identically to a partnership. Ranking seats removes the inference.

## Steps

### 15.1 [Split player from seat](stage-15/1-split-player-from-seat.md)

The platform rename, including the storage columns and the session path, the tagged `layout` metadata field with its load-time checks, the `seat_plan` reserved choice parameter beside the renamed `players` one, the derived player and seat counts, one shared plan resolution per language, the TypeScript shape guard, and the regenerated registry JSON. Every environment stays on player bounds and the canonical `solo` plan, so nothing changes behaviorally.

### 15.2 [Results and binding move to the seat](stage-15/2-results-and-binding.md)

The mean reduction in the runner, one `game_results` row per seat keyed by the renamed `seat_index`, forfeits charged to the seat after the reduction, the seat-to-player map in the recording header, submission staging per seat, `frontend/src/lib/standings.ts` ranking seats, and `winnerId` reporting the winning seat. Local play needs no separate work here: `scripts/play.py` serves the same frontend bundle, so it picks up seat-ranked standings from that one change. Every environment is still one player per seat, so this prepares the result and binding changes that close the three Spades defects when Stage 15.4 adopts the partnership topology. This step also implements the memory and time scaling described above.

### 15.3 [The environment rename](stage-15/3-environment-player-rename.md)

The mechanical pass across the three environments, their templates, examples, guides, local play, the shared card renderer, and every test that asserts on the old names. This lands on its own so the diff stays reviewable and so a failure here cannot be confused with a failure in the model above it.

### 15.4 [Spades gains the partnership plan](stage-15/4-spades-partnership-plan.md)

Spades declares its two seat plans with the partnership plan first, and a test pins the partnership seats against `spades.rules.team_of`. Adopting the partnership topology closes the three Spades defects. The four interface decisions land here, along with the projected game count in the season config editor.

## Exit criteria

- `uv run python scripts/ci.py python` and `uv run python scripts/ci.py generated-code-fresh` pass, so the registry JSON matches the metadata.
- `uv run python scripts/ci.py docs` passes after the specification and guide edits.
- Loading an environment whose declared plan has an empty seat, misses a player, starts at a nonzero index, has a gap, or assigns one player to two seats fails with a typed error naming the plan. Typed source construction cannot express a declaration that mixes the two styles or supplies neither. Runtime Python and JSON boundaries still reject missing, unknown, and mixed variant shapes, with tests for each.
- An environment with declared plans sizes `possible_agents` from the resolved plan, and `Episode.start()` asserts against the derived player count in both declaration styles.
- A season config or start form that names an unknown seat plan is rejected as an ordinary invalid parameter value.
- A seat with no human-capable member is never offered to a human. A wide human assignment is rejected until it has one legal companion choice, and launch expansion makes only the first human-capable member external.
- The chat input is enabled only on the designated human player's current turn. The harness drops an inactive sender, a stale tick, or a disallowed direct recipient without forfeiting anything, while broadcast remains available and records that acting player as its sender.
- One reduction test pins the whole table: score means, compute time and acted ticks and LLM usage sum, `failed` is a logical or, and `sum(ms) / sum(ticks)` is unchanged when a seat of two players is compared against two seats of one.
- A test covers an uneven plan, where a one-player seat and a three-player seat appear in the same game and each reports one score.
- An `act` call exceeding `step_limit_ms` receives the environment's legal default action and continues. A later `chat` or `learn` overrun preserves the selected action. Neither form alone forfeits the seat. A player exceeding `episode_limit_ms` fails only its own seat, and the surviving seats keep their honest scores.
- A one-player session receives exactly today's container memory, and a four-player one receives the base plus three increments. The chargeable workflow watchdog scales with the resolved player count and refuses launch rather than overflowing.
- Every recording header written by this stage carries the seat map and the plan key. Neither is optional at the read boundary, and a header missing either is malformed. The player count is read from the seat map rather than stored beside it, and `schema_version` holds at 1.
- The partnership plan expands to P(N,2) seatings with the Naive baseline row still appended, and a one-player-per-seat environment produces today's schedule unchanged.
- A Spades submission's board row on the partnership plan shows one game per game played rather than double-counting its two positions.
- No occurrence of `my_seat`, `partner_seat`, `min_slots`, `max_slots`, `human_slots`, or the reserved `seats` parameter remains in active implementation, schemas, templates, or current public and contributor documentation. Plan migration explanations and historical plans are excluded. The word `slot` is gone from the storage schema and the session path, and the shared card renderer's screen-position field is named `position`.
- `uv run python scripts/play.py spades --parameter seat_plan=partnership` and the corresponding `seat_plan=solo` command both run locally, and `uv run python scripts/ci.py frontend-e2e` passes after the seat dialog, standings, and replay-label changes.
- A Spades season runs end to end on each plan through the admin console, the projected game counts match the figures above, and the partnership replay list shows a winner rather than "Tied". A human session on each plan shows the seat-grid hint, the explicit companion choice for a wide seat, mixed standings attribution, turn-authoritative chat with partner and broadcast targets, and the renderer's partnership marking.
