# Stage 16.2: Matchup and session enforcement

Status: complete.

Part of [Stage 16](../stage-16-named-builtins.md), build-order step 2.

## Outcome

A season matchup names any declared builtin in any seat, one shared validator enforces the seat plan's restriction wherever a config is accepted, and live-session validation applies the same rule at the assignment boundary.

## Matchup configuration

The compact match-seat vocabulary becomes:

```ts
type SeatSpec = 'submission' | `builtin:${string}`
```

One parser validates the prefix and the snake_case name. `SEAT_SPECS` in `schema/ts/src/schedule.ts` is a closed two-value array today and the `z.enum(SEAT_SPECS)` in `backend/src/storage/season-config.ts` depends on it, so the codec moves to a refinement over that parser and the admin editor takes its options from environment metadata instead of the array.

For example, if `seat_0` is restricted to `scripted_hero`, this is valid:

```json
["builtin:scripted_hero", "submission", "submission"]
```

These are invalid:

```json
["submission", "submission", "submission"]
["builtin:naive", "submission", "submission"]
```

## One environment-aware validator, two call sites

Structure-only decoding accepts a well-formed compact string. The environment-aware checks take the resolved layout as a parameter and require that every builtin name is declared, that each row has exactly one entry per resolved seat, and that a restricted seat carries its designated builtin. Each call site resolves the layout once from the parameters it already holds and passes it in, so one resolution governs both the validation and whatever the call site does next.

The seat-count half of that already exists as the private `validateSeatCounts` in `backend/src/admin/routes.ts`, called only from the config `PUT`. Stage 16 lifts it into one exported validator, `validateSeasonMatches`, adds the builtin-name and restricted-seat checks beside it, and calls it from two places:

- the config `PUT`, where `validateSeatCounts` runs today, resolving the layout from the season's parameters immediately before the call.
- the run trigger in `POST /seasons/:id/runs`, which already resolves parameters and the layout to obtain `layout.planKey` for `buildSchedule`; that same resolved layout now feeds the validator too, before scheduling.

A season saved before a metadata change therefore cannot freeze an illegal matchup into a run.

## Schedule behavior

`buildSchedule` in `backend/src/scheduler/build-schedule.ts` keeps its algorithm:

- K is the number of `submission` entries.
- Each `builtin:<name>` entry resolves in place to `{ kind: "builtin", name }`.
- Submitted agents expand only into the `submission` entries.
- The appended baseline fills only `submission` entries with `{ kind: "builtin", name: "naive" }` and preserves every configured builtin entry.

The change is confined to `resolveSeats`, whose else branch currently treats any non-baseline spec as a submission slot and advances the seating cursor. Left alone it would consume a submission for a named builtin and shift every later seat.

`projectSchedule` in `schema/ts/src/schedule.ts` derives K by counting entries equal to `'submission'`, so its width, P(N,K), C(N,K), seed, and game arithmetic are unchanged and only the `SeatSpec` type widens. The property test comparing projection against concrete expansion keeps them in lockstep.

## Live-session enforcement

The public assignment wire uses `{ kind: "builtin", name }`. After resolving the request's complete parameters, `validateSeatShape` in `backend/src/session/orchestrator.ts` applies the shape and restriction rule at the same boundary that enforces `human_players` today:

- An unrestricted seat keeps its existing legal Human, submission, and builtin assignments.
- A restricted seat accepts `{ kind: "builtin", name }` when the name equals `restricted_builtin`.
- It accepts Human when at least one player in the seat is human-capable.
- Anything else returns a 400 naming the seat and its allowed controllers.

One gate decides whether a builtin name is declared: `resolveAgentBinding`, which runs once per resolved seat and once per human companion. It rejects an undeclared name on an unrestricted seat's assignment exactly as on a wide Human seat's companion, before the session row is created and before any container work, so an unknown name never reaches image loading.

A wide restricted seat assigned to Human takes no client companion. Launch assembly derives one instance of the designated builtin for each remaining player, the way it already expands the baseline. Ordinary wide Human seats keep their explicit companion selection.

Installed environment metadata is authoritative during validation, and the recording carries the controllers that actually launched, so the session stores no restriction snapshot of its own.

## Specification

- [Leaderboard](../../docs/specs/leaderboard.md) defines the named compact seat specs and the full-width expansion they leave unchanged.
- [Interaction](../../docs/specs/interaction.md) defines the live Human-or-designated-builtin rule and the derived wide-seat companion.

## Tests

- Season config tests accept declared `builtin:<name>` values and reject malformed names, undeclared names, the wrong controller in the restricted seat, and row widths that do not equal the resolved seat count.
- The same rejections are asserted on both call sites: saving the config and triggering a run.
- Scheduler tests mix two named builtins with submissions, assert K counts only `submission` entries, preserve builtin positions in every expansion and in the baseline game, and prove projection stays in lockstep with expansion.
- A regression test covers a named builtin in a seat before a `submission` seat, so a cursor that advanced on the builtin would produce a visibly wrong seating.
- Backend API tests reject illegal restricted-seat assignments before session insertion or container work, and accept Human or the designated builtin.
- Backend API tests reject an undeclared builtin on an unrestricted seat and as an ordinary wide-seat companion.
- Launch tests prove a wide restricted Human seat receives only its designated builtin companions and that a client-supplied companion for that seat is rejected.
