# Stage 15.2: The environment rename

Status: complete.

Part of [Stage 15](../stage-15-wide-seats.md), build-order step 2.

## Outcome

The environments, student APIs, local-play tools, and shared card renderer use player for a PettingZoo position. The renderer separately uses position for a visual location around the table. This is a behavior-preserving vocabulary pass, and Spades still uses four singleton seats until [step 4](4-spades-partnership-plan.md).

It follows the platform rename directly and depends on nothing beyond it. Step 1 left the word `seat` meaning an assignable unit in the backend and the session API while it still meant a table position inside the environments and the shared renderer, so closing that gap before the result model moves keeps one meaning of the word in the tree at a time.

The hands-on check runs every bundled example against its environment, plays Hearts and Spades locally with player-named observation helpers and the seat-aware maintainer launcher, and renders the same four table positions without any seat or slot term standing in for a player.

## Environment metadata and factories

Complete the remaining environment vocabulary around the player-bound registrations changed in step 1 across `environments/flappy_bird/__init__.py`, `environments/hearts/__init__.py`, and `environments/spades/__init__.py`. Rename factory locals and comments that still call `possible_agents` slots or seats. The resolved `players` parameter determines each factory's player count, even though the current fixed bounds make the resolved value constant.

Keep behavior, action and observation spaces, random seeding, and scoring unchanged. This step does not add a compatibility alias for an old field or helper because Stage 15 targets a fresh pre-release checkout.

## Hearts and Spades contracts

Apply one coordinated rename across each card environment so the wire observation, overlay, helper, rule, and guide agree in the same commit:

- Observation key `seat` becomes `player`.
- Spades observation key `partner_seat` becomes `partner_player`.
- Trick entries use `player` instead of `seat`.
- Overlay fields use `turn_player` instead of `turn_slot`, and trick entries use `player`.
- Hearts helper `my_seat` becomes `my_player`.
- Spades helpers `my_seat`, `partner_seat`, and `partner_of(seat)` become `my_player`, `partner_player`, and `partner_of(player)`.
- `__all__` exports, type annotations, docstrings, and error messages use the same names.

Rename player-valued parameters and locals throughout `environments/hearts/rules.py`, `environments/spades/rules.py`, and both `env.py` modules. In `environments/spades/rules.py`, `team_seats` becomes `team_players`, while `team_of` keeps its name and only its `seat` parameter is renamed to `player`. Apply the same rename to legal-action helpers, automatic-action helpers, score helpers, and the private id conversion functions. Use `player_id` for `player_N` strings and `player` or `player_index` for numeric positions consistently.

In `environments/local_play/card_spaces.py`, rename `NUM_SEATS` to `NUM_PLAYERS` and change the shared trick-entry space key to `player`. Update the Hearts and Spades overlay extractors and scene builders in the same pass so no old and new payload shape coexist.

## Student surface and generated template

Update the Hearts and Spades template `sandbox/cards.py` helpers, template agents, tests, bundled examples, and environment guides. The guides explain player numbers and Spades partnerships in player language while reserving seat for the platform assignment that may cover several players. Update command examples and expected dictionaries exactly rather than documenting both spellings.

The two `--seat` flags part company here, and they end up with different names on purpose. `templates/base/sandbox/play.py` and `templates/base/sandbox/evaluate.py` use `--seat` to pick a PettingZoo position, so it becomes `--player` along with the headless helper arguments behind it. The maintainer `scripts/play.py` keeps `--seat` and becomes a genuine seat selector, resolving a `seat_N` index rather than indexing a player array. One flag names a position and the other names an assignment that may cover several of them, so a reader meeting both should see two names. Step 4 adds the companion choice needed when that selected seat covers more than one player.

Rename `possible_slots` and any remaining player-shaped slot locals to their player equivalents in all three files. The live config already uses `player_bindings` after step 1. The template flag appears in `environments/hearts/template/README.md` and `environments/spades/template/README.md`, in the "Useful extra flags" line showing `python -m sandbox human --seat 2`, so those examples and the generator-owned copies of both files move with it.

Update `scripts/_template_gen.py`, `scripts/_envs.py`, and `scripts/generate.py` inputs where the student-facing vocabulary is embedded. Regenerate template snapshots, generated types, registry JSON, JSONL fixtures, and golden recordings through the project generator. Do not hand-edit a generated artifact to hide a stale source.

The public and contributor documentation follows the same contract, including `docs/contributors/environments/index.md`, `docs/contributors/environments/package.md`, `docs/contributors/environments/template-and-examples.md`, and `docs/contributors/testing/browser-e2e.md`. The index page's play-test section says "Pass `--seat` for a multi-slot seat". It documents the maintainer launcher, so the flag name survives, but "multi-slot seat" does not: it becomes a seat from the environment's resolved layout, which is one player today and may be several after [step 4](4-spades-partnership-plan.md).

## Shared card renderer

Refactor `frontend/src/renderers/cards/scene.ts` by meaning, not by global replacement:

- `SceneSeatBase.seat`, `SceneTrickCard.seat`, `ViewContext.viewSeat`, and `controlledSeat` are numeric table players. The two `seat` fields become `player`, and the other two become `viewPlayer` and `controlledPlayer`.
- `CardOverlay.turnSlot` is the `player_N` agent id. Rename it to `turnPlayerId`.
- `seatOfSlot` parses a `player_N` id into a numeric player. Rename it to `playerOfId`.
- `SceneSeatBase.slot` is a visual screen location with South, West, North, and East ordering. Rename it to `position`, and rename `slotOfSeat` to `positionOfPlayer`.

Carry these exact meanings through `CardTableRenderer`, the Hearts and Spades scene adapters, renderer fixtures, click targets, labels, and tests. Do not expose the visual `position` as a gameplay player number. The state and overlay payloads continue to use stable `player_N` ids at their transport boundary and convert once inside the scene builder.

Renderer modules under `environments/<env>/renderer/` may retain game-specific colors, but this step introduces no new visual pattern and no new shared CSS.

## Specification and guide edits

This step owns no `docs/specs/` file, and that is deliberate rather than an omission. The specifications describe platform contracts, and this rename touches student-facing and contributor-facing vocabulary only. The nine specification files the Stage 15 overview lists are revised by steps [1](1-split-player-from-seat.md), [3](3-results-and-binding.md), and [4](4-spades-partnership-plan.md), each alongside the contract it changes.

## Tests

Environment tests for Hearts and Spades update every expected observation, trick entry, overlay, helper export, rule keyword, and error. Add direct helper tests that `my_player`, `partner_player`, and `partner_of(player)` agree with the environment's `player_N` ordering. Flappy Bird tests pin the `players` parameter even though its value remains one.

Template and example tests import only the new helper names. A repository search test or explicit CI assertion excludes `my_seat`, `partner_seat`, and the old observation keys from current template and public-documentation roots, while allowing historical plans and Stage 15 migration explanations.

Local-play tests cover `--seat`, its resolution through the layout to the one player each singleton seat covers, construction of the designated external player, and human action routing. The base template's player-selected play and evaluate commands receive the same coverage through generated-code freshness. Seat-ranked standings belong to [step 3](3-results-and-binding.md) and the wide-seat companion choice to [step 4](4-spades-partnership-plan.md), so neither is asserted here.

Shared scene tests separately pin:

- Transport `player_N` parsing.
- Numeric table-player rotation around each viewer.
- Stable South, West, North, and East visual positions.
- Controlled-player interaction.
- Hearts and Spades overlays using `turn_player` and trick-entry `player`.

Run the Python, frontend unit, generated-code freshness, and docs checks. Run the existing browser journeys that use the card renderers so a stale locator or payload name cannot pass on jsdom alone.

## Done when

The three environments and all current student-facing material speak only in player terms for PettingZoo positions. The maintainer launcher uses `--seat` for assignment, generated artifacts are fresh, and the shared card renderer has separate names for player ids, numeric table players, and visual positions. Every existing game behaves and renders as it did before this naming pass.
