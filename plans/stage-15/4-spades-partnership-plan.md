# Stage 15.4: Spades gains the partnership plan

Status: not started.

Part of [Stage 15](../stage-15-wide-seats.md), build-order step 4.

## Outcome

Spades offers a default two-seat partnership layout and an explicit four-seat solo layout. The session form, automated scheduler, workflow, standings, recordings, local play, and renderer all use the selected topology. One submission can control both players of a partnership without changing the environment's four-player PettingZoo contract. A human partnership seat instead has one designated human player and one explicitly chosen companion agent.

The hands-on check starts and completes one human session and one season run on each plan. The partnership plan asks for two seat assignments, requires a companion choice for a human seat, produces two result rows, marks partners across the table, and labels a decisive replay with its winning seat rather than as tied.

## Spades metadata and factory

Replace Spades' `PlayerBounds` layout with a `SeatPlans` layout holding two ordered `SeatPlan` values:

1. `partnership`, titled `Partnership`, with seats `(0, 2)` and `(1, 3)`.
2. `solo`, titled `Solo`, with seats `(0,)`, `(1,)`, `(2,)`, and `(3,)`.

The generated `seat_plan` parameter therefore defaults to `partnership`. The Spades factory always creates the same four `player_N` positions because both plans cover four players. The plan changes assignment and ranking only, not rules, observations, actions, turn order, or team scoring.

Add a direct invariant test against `environments/spades/rules.py`: every member of one declared partnership seat has the same `team_of(player)`, the other seat has the opposing team, and `team_players` returns the exact declared pair. Keep the plan tuple as the metadata source of truth rather than duplicating a special partnership layout in the backend.

Update the maintainer local-play CLI with repeatable typed parameter overrides, validated through the environment's normal declarations, so `--parameter seat_plan=partnership` and `--parameter seat_plan=solo` select the layout without a Spades-only flag. `--seat N` selects one resolved seat after those parameters are applied. The first human-capable member in that seat's declared order becomes the external human player. A wide human seat also requires an explicit `--companion` choice, accepting `naive` or a local agent manifest path, and creates an independent companion instance for every remaining player in the seat. The CLI continues to route actions by active player, so no extra human-player selector is needed.

## Session and workflow behavior

The start API receives exactly two `seat_N` assignments for `partnership` and four for `solo`. An ordinary seat assignment names Naive or one submission. A human assignment names Human plus its companion agent when the resolved seat is wide. Backend validation resolves parameters first, then validates the exact seat set, requires at least one human-capable member for a human seat, derives the first such member as the designated human player, and requires a legal companion exactly when other members remain. The launch-config expansion from step 2 creates separate player instances for each partnership submission. For a human partnership seat it creates one external binding and independent companion bindings for the other players.

The scheduler uses `layout.seatCount`:

- Partnership uses ordered two-seat assignments because Spades has `seat_order_matters`.
- Solo uses ordered four-seat assignments.
- The appended all-Naive assignment remains one additional assignment in either layout.
- `games` still repeats each assignment with deterministic seeds.

For one all-submission match at a ready roster of 20 and `games: 2`, tests pin 762 partnership runs and 232,562 solo runs. The workflow stages one overlay per assigned seat, reduces four player results to two or four seat results as selected, and charges a failed player only to its partnership seat when attribution is available.

Board aggregation counts one game for each seat a submission played. A partnership submission does not receive two games, two scores, or two copies of compute telemetry merely because it controlled two players.

## Seat assignment dialog

Refactor `frontend/src/components/SeatAssignmentDialog.vue` around the resolved layout. Render one row per `seat_N`, keep the existing agent and human controls, and show a short player-count hint after the control:

- `1 player` for a singleton seat.
- `2 players` for each Spades partnership seat.
- The same pluralized pattern for an uneven future plan.

Do not list member player ids in the assignment row. Emit the selected values as a `seats` object keyed by the layout's exact seat ids. A seat offers the human option when at least one member is listed in `human_players`; the backend and browser both derive the first capable member in declared seat order. Selecting Human for a wide seat reveals a required Companion agent control with the same Naive and submission choices as an ordinary agent assignment. Singleton human seats omit the companion field. The single-human-per-session limit remains unchanged.

Changing the `seat_plan` parameter rebuilds the grid from the new layout. Preserve an assignment and companion choice only when the seat id still exists and each selected option remains legal for the new layout. Clear any now-invalid selection, show the normal required-field state, and do not submit a stale two-seat assignment against the four-seat plan.

Add the count hint using existing field and text primitives plus semantic tokens. Show the changed row and hint states on the dev-only styleguide only if a new reusable primitive variant is actually needed.

## Human turns and chat

A human assigned to a partnership seat controls only the first human-capable member in declared seat order. The chosen companion agent acts for the other member using its own instance, state, action budget, and chat output. The normal move prompt and existing card interaction apply only when the designated human player acts. Only that player's turns receive `human_timeout_ms`.

Add an optional live-state `chat_policy(sender)` hook on the running environment instance. It returns an ordered set of allowed direct recipients and a default recipient for the current game state. The hook is a runtime environment extension rather than serialized metadata. Broadcast is always available as `to: null` and cannot be removed by the hook. Without a hook, every other player in the resolved layout is an allowed direct recipient and broadcast is the default, preserving the current generic behavior. Validate that direct recipients are unique resolved players other than the sender and that the default is either broadcast or one of those recipients. An invalid hook result is an environment fault. Spades implements the hook by placing the sender's partner first and making that partner the default, followed by the other direct recipients that its live state permits, while broadcast remains available.

Expose the current messaging contract for an external turn in step state as optional `chat_options` with `sender`, `target_recipients`, `default_recipient`, and an opaque `turn_token`. The live loop creates a new token for every external action opportunity rather than reusing the state tick. Extend `schema/step-state.schema.json`, the generated state types, the shared command protocol, and the Python live-command parser together. A human chat command carries the sender and required turn token. `frontend/src/pages/SessionPage.vue` enables the composer only when `chat_options.sender` is the designated human player and the token belongs to the current nonterminal state. `ChatPanel` renders exactly the allowed direct recipients plus `Everyone`, resets its selection to the new default when the turn token changes, and sends the sender and token with the message.

The harness is authoritative. It accepts human chat only from the current designated external actor with the current token, recomputes the environment policy against live state, and rejects stale, spoofed, or newly disallowed messages. It drains only the current human player's queue. The relay's membership and message-cap checks remain an earlier validation layer, not proof that the message is legal in the current turn. Apply the same live recipient policy to agent chat output before relay delivery.

Unit tests advance through the human, companion, and opposing players' turns. They verify that browser actions and chat are available only for the designated human player, that the companion agent acts independently, that partner-direct and broadcast messages are accepted, and that stale, spoofed, inactive-player, and policy-disallowed messages are dropped.

## Standings, recordings, and replay labels

Use the recording header's `seats` map for every presentation:

- Live and final standings show two partnership rows or four solo rows.
- An ordinary row leads with its submission or Naive label and shows covered players as secondary detail. A mixed human row names both Human and the chosen companion agent.
- Blind play windows keep the existing numbered private label, applied once per seat.
- Replay-list and Game Over winner text name the winning seat's attribution.
- Dense ranking applies to seat scores, so equal opposing seats can still tie without being mistaken for a partnership.

Spades reports the same team score for both partners. The partnership reducer therefore preserves that score as the mean. A decisive partnership recording has one highest seat and no longer reaches the tie sentinel. The solo plan continues to report four seat rows based on the environment's player-level team scores, including ties implied by that selected topology.

Local play needs no separate work. `scripts/play.py` serves the frontend's local bundle, so the same standings change reaches it. Add recording fixtures for both plans, each carrying the `players` attribution object, the `seats` membership object, the player count, and the plan key.

## Partnership renderer

Extend only `environments/spades/renderer/` to mark the two seats declared by the resolved partnership plan. Derive the grouping from the recording or live-session seat map rather than from hard-coded opposite-player arithmetic. The solo plan renders no partnership grouping.

Use the renderer's existing visual language and game-owned color freedom. The mark must remain legible from every rotated viewer position, must not obscure cards, bids, scores, or current-turn state, and must have a textual or structural cue available to screen-reader-facing surrounding UI rather than relying on color alone.

Scene tests cover partnership and solo maps from each viewer rotation. Browser snapshots or locator-based assertions cover the visible grouping without coupling to raw coordinates.

## Exact schedule projection

The projected count is a pure function of the draft configuration, the resolved seat layout, and one number the browser does not already have: how many submissions are currently eligible. Give the editor that number and the projection is arithmetic it can do itself as the operator types, with no round trip and no second copy of the run trigger's eligibility rules.

Put the pure projection helper in a dependency-free module within the shared schema package, for example `schema/ts/src/schedule.ts`, and export it through an explicit `@game-sandbox/schema/schedule` subpath so the browser and backend execute the same implementation. Move the minimal `SeatSpec` and projection input types needed by that helper into the same module. Backend codecs may import those types and constants while keeping Zod and schedule materialization backend-only. The helper accepts the complete validated `MatchConfig[]`, eligible submission count, resolved seat count, and `seat_order_matters`. It first validates every match's seat-spec length against the resolved layout, then returns:

- Eligible submitted assignments per match and in total.
- The one appended all-Naive assignment per match.
- Games per match and in total after each match's `games` repetition.

For each match, count only its `submission` seat specs as `K`. Use falling permutations for ordered seats and combinations for unordered seats, matching `buildSchedule` exactly. A mixed match with one submission seat and one Naive seat therefore uses `P(N, 1)` or `C(N, 1)`, and a match with no submission seat has only its appended baseline. Compute the counts without materializing assignment arrays, use safe-integer checks, and return a typed validation error if an exact result cannot be represented. Tests compare each match and total projection with the actual schedule length over small rosters, including mixed and multiple match rows, and pin the 20-submission Spades figures for the all-submission match.

Add the eligible submission count to the admin season payload `frontend/src/pages/AdminConsolePage.vue` already fetches and passes down. The backend computes it through the same season and dependency filters the run trigger uses, so the number an operator reads is the roster a run would actually draw from. It is a count, not a roster listing, and it does not depend on the draft.

`frontend/src/components/admin/SeasonConfigEditor.vue` receives that count as a prop and recomputes the projection locally whenever the draft changes, which covers the environment, any layout-affecting parameter including `players` or `seat_plan`, a seat spec, a seed list, and a games value. The editor already validates its draft against the environment's parameter declarations and already resolves the layout for the seat-spec controls, so no new validation path appears. Display the exact total near the match controls, with per-match submitted-assignment and all-Naive components in supporting text. An invalid draft shows no total rather than a stale one, and a roster change is reflected the next time the editor opens. Nothing here creates a run, freezes a snapshot, or stages a submission, because the draft never leaves the browser.

## Specification edits

This step settles the interface behavior, so it revises:

- [Frontend](../../docs/specs/frontend.md): the seat grid with its player-count hint and explicit companion control, mixed human and companion attribution, seat-ranked standings and their member-player detail, the season config editor's projected total, and the replay label. That last one is a correction rather than an addition: the file currently documents multiple top-ranked seats producing `Tied` as intended behavior, which was the first of the three defects the Stage 15 overview names.
- [Interaction](../../docs/specs/interaction.md): deterministic designation of one human player, the required companion for remaining members, the human move clock, and authoritative turn-token validation.
- [Communication](../../docs/specs/communication.md): the live-state recipient hook, guaranteed broadcast, current sender and turn token, and harness enforcement for human and agent messages.

Also revise `docs/contributors/environments/index.md` for the maintainer launcher's wide-seat `--companion` requirement, and revise `environments/spades/environment.md` to explain that direct choices come from live game state, the partner is the default direct target, and broadcast to everyone remains available.

## Tests

Backend and scheduler tests cover:

- Default partnership and explicit solo parameter resolution.
- Exact request shapes, companion requirements, deterministic human-player designation, and human capability for both plans.
- Ordered schedule contents for two and four seats, the all-Naive assignment, game repetition, and the pinned roster-20 totals.
- Projection equality with materialized schedules across small ordered and unordered cases, including mixed Naive/submission seats and multiple match rows.
- The eligible submission count in the admin season payload matching the roster a run trigger would draw, and safe-integer failure in the projection helper.
- One staged submission and one result per partnership seat despite two player instances.
- A partner crash forfeiting only its seat, while an unattributed fault forfeits both seats.
- Correct board game counts, summed telemetry, mean score, winner id, and true-tie handling.

Frontend unit tests cover plan switching, grid row counts, count hints, companion selection and invalidation, any-member human eligibility, mixed attribution, seat-ranked standings, member-player detail, blind labels, winner copy, the projected total updating as the draft changes and clearing when the draft is invalid, and designated-player chat gating.

Environment and renderer tests cover metadata-to-rule agreement, both local-play plans, the Spades live-state chat policy, partnership marks, solo rendering, and all viewer rotations. Harness tests cover the human sender and token checks, live-policy revalidation, broadcast, and the same recipient checks for agent output. A synthetic messaging environment with no hook pins every other resolved player in canonical player order as the direct choices and broadcast as the default in human `chat_options`, then exercises the same fallback against agent output. Regenerated recording fixtures cover both header maps and both result topologies.

Revise the existing Playwright Hearts and Spades journeys for the renamed contracts. Add Spades journeys that start a human session on both plans, exercise the designated human turn and companion-controlled partner turn, send a partner-direct message and a broadcast, inspect mixed final standings and replay winner text, and verify the partnership mark. Run the real Docker-backed workflow integration on each plan and the full frontend end-to-end suite.

## Done when

Spades runs through the admin console, workflow, browser, replay, and local play on either selected plan. Partnership mode assigns and ranks two seats, solo mode assigns and ranks four, the editor shows the exact projected game count before a run, and a human partnership seat combines one deterministic human player with an explicitly chosen companion agent. Direct chat follows the environment's live-state policy, broadcast remains available, and the harness rejects stale or unauthorized messages. The table visibly communicates the selected partnerships, and the three player-ranking defects named in the Stage 15 overview are closed on the partnership plan.
