# Stage 7.7: Hearts Renderer and On-Screen Input

Status: done. The `hearts` renderer draws the hand, current trick, turn indicator, per-slot penalty scores, and move clock, with click-to-play, illegal cards greyed straight from the emitted legal-action mask, and trick-by-trick replay. The jsdom scene, replay, animation, and input tests pass; the canvas draw, trick-sweep animation, and click-to-play were verified once in a real software-WebGL browser. The in-browser human-seat and per-seat-replay journeys land as Stage 7.8 e2e additions. The host wiring that narrows a live human's `controlledSlots` to their single assigned seat is step 6's (the renderer already views whatever single slot it is given).

Part of [Stage 7](../stage-07-multi-agent.md). This is build-order step 7 and the last functional step. It draws Hearts and turns clicks into card plays. It is Docker-free frontend work, tested against fixtures and recordings the way the Stage 4 renderer was, separately from live session control. It depends on the environment state schema from step 1; the live human-slot wiring it drives is exercised by steps 5 and 6.

## Why this is its own seam

Rendering and on-screen input are pure functions of session state, so they test against fixtures and recordings without a live session, mirroring the Stage 4 renderer-versus-live split. Building the renderer last means it draws against the real recorded Hearts state shape that steps 1, 5, and 6 have settled, rather than a guess. The on-screen input UI from [interaction.md](../../docs/specs/interaction.md) replaces raw device input for Hearts.

## What to build

A `hearts` renderer under `frontend/src/renderers/hearts/`, extending the Pixi base and registered once in `frontend/src/renderers/index.ts`, with a pure `computeScene(state)` like `frontend/src/renderers/flappy-bird/scene.ts`. The renderer is the `renderer="hearts"` key the environment metadata declares in step 1. This is the browser renderer for the web app; it is distinct from the local Python renderer step 1 ships for students testing in pygame, though both draw the same recorded state and grey from the same legal-action mask.

It draws:

- The player's hand.
- The current trick.
- A turn indicator.
- The running per-slot penalty scores.
- The active move clock, using the session value.

## On-screen input

Clicking a card plays it. Cards that are not legal on the current turn are greyed out: wrong suit when the led suit is held, hearts before broken, and the first-trick restrictions. The greying reads the legal-action mask the environment emits into the recorded state (step 1), not a JavaScript reimplementation of the rules, so the browser and the environment never disagree about legality. The move-clock display lives here; the timeout behavior that auto-plays a legal move lives in step 5.

## Replay

The replay of a multi-agent match renders trick-by-trick turns and per-slot penalty scores correctly, using the same `computeScene` path as live rendering.

## Tests

Vitest, jsdom, no canvas, no network, following the Stage 4 and 5 renderer test pattern:

- `computeScene` greys exactly the cards absent from the emitted legal-action mask, across representative led-suit, hearts-not-broken, and first-trick fixtures.
- Per-slot penalty scores and the turn indicator render from a fixture state.
- A recorded multi-agent Hearts fixture replays trick-by-trick with correct per-slot penalty scores.

## Implementation notes

The browser renderer is a deliberate port of the local pygame renderer (`environments/src/hearts/render.py`): same 960x720 table, the same N/E/S/W seat layout with the view seat at the bottom, the same fan geometry, suit pips drawn from primitives, card backs, and the same status strip and rule hints. `frontend/src/renderers/hearts/scene.ts` carries cross-references to the matching `render.py` symbols so the two stay in lockstep, and the legality greying reads the emitted mask verbatim in both. One intentional deviation: the bottom seat is tagged "(you)" and gets the move clock only when the viewer actually controls it, since a replay's bottom seat is not the viewer; the local renderer always marks its own view seat.

Animation and replay. The owner asked for the trick-won sweep (and the active-seat glow) to animate in replay too, at replay-time scale, rather than being dropped to keep determinism. So the pure `computeScene` still returns the static "snapped" frame a scrubber lands on, and a thin animation layer rides on top: the shared `PixiRenderer` base gained an optional per-frame loop (an `animated` flag and an `onFrame` hook driven by the PixiJS ticker), and `RendererInstance.render` gained a `RenderOptions` argument. The replay transport now passes that cadence as a transition budget while playing and `snap` on any scrub, step, or seek, so an animated renderer fits its transitions inside the replay cadence and never animates a jump. Flappy Bird is unaffected: it leaves `animated` false and ignores the options, so it stays draw-only.

Card-play fly-in and hover. The owner then asked, so a viewer can tell _which_ card each player sent out, to highlight and fly the played card from its owner into the centre rather than snapping it. So beyond the sweep, every card now animates from the player who played it: when a snapshot adds a card to the trick, the renderer briefly highlights that card where it sat in the player's revealed hand (or an opponent's row), then eases it into its trick spot. The fly-in is a second pure detector + easing pair beside the sweep's (`detectPlay`/`playCardAt` in `scene.ts`), driven by the same per-frame loop; while the card slides, the retained renderer holds the source hand/row at its _previous_ layout, leaving a placeholder gap where the played card was, so the remaining cards do not re-fan until the card lands. Because the fourth card resolves its trick in the same step (`rules.play`), its fly-in chains straight into the sweep, and the two phases are sized from one shared transition budget so the chained pair finishes inside the replay cadence (the next snapshot never cuts the sweep short). The airborne card is drawn on a dedicated layer above the hand fan, so it lifts cleanly off its neighbours instead of being occluded by them. A hover highlight (gold ring + small lift) rides on hand cards only when the hand is interactive — live play — and is absent in replay/spectator, which have no controlled slots. All of this runs in both replay/watch and live play: at replay-time scale when a cadence is given, natural length when live.

Local renderer parity. The pygame twin (`environments/src/hearts/render.py`) mirrors the fly-in (the chain into the sweep and the held-layout placeholder included) and the hover, gated to `render_mode == "human"` — which covers both live human play and the spectator `watch` session, both of which open a window — so the headless `rgb_array` path stays a single deterministic frame for recordings and CI. The fan and opponent-row geometry lives in one pair of layout helpers reused by drawing, hit-testing, and the fly-in origin, so the two never drift. The human controller (`environments/src/hearts/human.py`) threads the mouse position to the renderer each frame so hover tracks the cursor on the player's turn, and clears it on exit. The local renderer shows no separate game-over banner: the per-seat penalty scores on the badges and the status strip already report the finished hand, and the host overlay owns the end-of-game screen.

Game-over is host chrome, not the renderer's. The end-of-match screen is a single cross-environment leaderboard shown the same way in the web app and Python local play, so neither renderer draws it into its canvas. A shared `buildStandings` (web: `frontend/src/lib/standings.ts`; Python twin: `scripts/play.py` `_standings`) ranks slots by the cumulative reward (higher-is-better at terminal for every env) and shows each game's natural score (Hearts' penalty points, Flappy Bird's pipes), with gold/silver/bronze cups for the top three. The two read the same standings from different sources: local play accumulates a live per-seat reward tally, but a recording stores only the _acting_ agent per tick (a four-seat Hearts terminal frame carries one player in `state.agents`), so the web reconstructs every seat from the overlay's seat-indexed `leaderboard_scores`/`display_scores`, falling back to the `agents` map only for a single-slot env. Labels come through the shared `attributionLabel` (`frontend/src/lib/attribution.ts`), so the leaderboard honours the same blind policy as the per-slot attribution line. The web draws it as a non-modal DOM overlay (`frontend/src/components/GameOverCard.vue`) over the renderer host on the live session and replay pages, shown only when the run reached a natural conclusion (`isCompletedOutcome` in `replay/reason.ts` — terminal or episode-cap, not a stop/idle/crash), mirroring Python; Python draws the matching dimmed leaderboard in `scripts/play.py` (`_draw_leaderboard`) over the final frame, for a terminal or step-capped episode but not a quit. The Hearts renderer's old in-canvas "Game over" + ranking (the `terminalSummary` block in `index.ts`/`scene.ts`) was removed in favour of this; the status strip keeps only its "Game over" message.

Move clock. Per the owner's choice, the renderer draws a deterministic per-move budget chip (the session `human_timeout_ms` in whole seconds) on the controlled human's turn, and nothing in replay or spectator views (where there are no controlled slots). A true ticking countdown, if wanted later, is host chrome that may use the wall clock; the renderer stays a pure function of state plus mount-time config.

## Done when

A Hearts session renders the player's hand, the current trick, a turn indicator, per-slot penalty scores, and the move clock from the session value. Clicking a legal card plays it, and illegal cards are greyed from the environment's emitted legal-action mask, so the browser never recomputes legality. A replay of a multi-agent Hearts match renders trick-by-trick turns and per-slot penalty scores correctly. The jsdom scene and replay tests above pass with no canvas or network.
