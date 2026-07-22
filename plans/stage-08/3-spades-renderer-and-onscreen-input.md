# Stage 8.3: Spades Renderer and On-Screen Input

Status: completed.

Part of [Stage 8](../stage-08-communication.md). This is build-order step 3 and the step that completes Spades as a product before any communication work begins. It draws Spades in the browser and turns clicks into bids and card plays. It is Docker-free frontend work, tested against fixtures and recordings the way the Stage 4 and Stage 7 renderers were, plus one deliberate backend registration described below. The hands-on surface at the end of this step is the full game in the web app: watch an all-Naive Spades session through the dev stack, take a seat and bid and play on screen, and open the replay. Because the Stage 7 scheduler and boards are entirely metadata-driven, a Spades season can already be seeded and run; the forfeit floor registration is the only backend line that season needs.

## Why this is its own seam

Rendering and on-screen input are pure functions of session state, so they test against fixtures and recordings without a live session, mirroring the Stage 4 renderer-versus-live split. Everything the renderer draws was settled in step 1 (the overlay, the mask, the display scores), so this step is a port, not a design. Landing it before the chat work means the whole communication half of the stage develops against a finished, browser-playable game, and the chat panel (step 6) arrives as chrome beside a working renderer rather than alongside one under construction.

The chat panel is deliberately **not** part of this step. Messages are environment-agnostic, so the panel is host chrome like `DecisionLog.vue`, not renderer content; this renderer needs to know nothing about messaging, and any future messaging environment gets the panel for free.

## What to build

A `spades` renderer under `environments/src/spades/renderer/` (`index.ts`, `scene.ts`, `thumbnail.svg`), extending the shared Pixi base through the `@renderers` alias and default-exporting the `renderer="spades"` definition for automatic discovery. It serves both the web app and loopback local play, and reads legality verbatim from the emitted mask.

It draws:

- The player's hand and the current trick, on the Hearts table geometry.
- Per-seat `bid/won` badges, with a NIL marker on a nil bidder.
- The two team scores, with the partnership visually legible: partner seats share a colour across the table.
- A spades-broken indicator, a phase indicator, a turn indicator, and the move clock from the session value.

### On-screen input

Input covers both phases, and both read the emitted legal-action mask rather than reimplementing rules. During bidding, a chip row 0 through 13 (0 labelled "NIL") is drawn for the controlled seat on turn, and a click maps to action `52 + k`; chips outside the mask are disabled. During play, clicking a legal card plays it and illegal cards are greyed exactly as Hearts greys them. Both paths send through the existing `sendAction` wiring, so live session control needs no change.

### Animation and game over

The animation layer reuses the shared `PixiRenderer` machinery and the Hearts fly-in and trick-sweep detectors: played cards fly from their seat into the trick and the won trick sweeps away, inside the same transition-budget rules Stage 7.7 established. Bids are badge highlights, not card flights: a bid changes a number, so the badge pulses rather than animating a flying chip.

Game over is host chrome: `buildStandings` in `frontend/src/lib/standings.ts` reconstructs every seat from the overlay's seat-indexed `leaderboard_scores` and `display_scores`, which the terminal Spades frame carries from step 1. Today it awards cups by row index after the sort, so the tied partners Spades produces by construction would take gold and silver for the same score. This step makes the medals tie-aware with dense ranking, the same rule step 1 applied to the local `play.py` standings: rows with equal rank scores share a medal, and the next distinct score takes the next medal, so the winning partnership shows two golds and the losing partnership two silvers.

### The Spades forfeit floor

Season boards score a forfeited seat through `forfeitScore` in `backend/src/leaderboards/score.ts`, and an unregistered environment falls back to zero. Every honest losing Spades hand is negative, so without a registered floor a crashed or overrunning seat would outrank honest play, exactly the crash-to-the-top exploit the floor exists to close. This step registers the Spades floor at minus 260, the worst achievable team score derived in step 1 (both partners bid 13; a 26-trick contract can never be made with thirteen tricks). It is the one backend change in the Spades half of the stage, kept here so the step that first makes a Spades season runnable is the step that makes it safe.

## Tests

Vitest, jsdom, no canvas, no network, following the established renderer test pattern:

- `computeScene` enables exactly the mask's bid chips during bidding and greys exactly the masked cards during play, across follow-suit and spades-not-broken fixtures.
- The `bid/won` badges, the NIL marker, the team scores, and the phase indicator render from fixture states.
- A recorded full-hand Spades fixture replays bid round and trick by trick with correct badges and team totals.
- The hit-tests map bid-chip clicks and card clicks to the right action integers.
- `buildStandings` awards dense tie-aware medals: a terminal Spades fixture gives both winning partners gold and both losing partners silver, and a Hearts-shaped fixture without ties keeps today's ordering.
- `forfeitScore('spades')` returns minus 260, and the score test keeps it at or below every honest outcome in the scoring matrix, following the existing Hearts floor test.

## Done when

A Spades session renders the hand, the trick, the badges, the team scores, and the phase, turn, spades-broken, and move-clock indicators in the browser. A connected human can take any seat, click a bid chip, and then click legal cards, with everything outside the emitted mask disabled, so the browser never recomputes legality. A replay of a full hand renders correctly, tied partners share a medal on the game-over standings, the Spades forfeit floor is registered so a forfeit can never outrank honest play, and the tests above pass with no canvas or network. At this point Spades is a complete game: locally playable (steps 1 and 2), browser playable, replayable, and seasonable through the existing seat-ordered scheduler, and the rest of the stage is purely about communication.
