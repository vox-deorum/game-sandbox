# Stage 7.7: Hearts Renderer and On-Screen Input

Status: done. The `hearts` renderer draws the hand, current trick, turn indicator, per-slot penalty scores, and move clock, with click-to-play, illegal cards greyed straight from the emitted legal-action mask, paced live moves from other seats, and trick-by-trick replay. The jsdom scene, replay, animation, and input tests pass; the canvas draw, trick-sweep animation, and click-to-play were verified once in a real software-WebGL browser. The in-browser human-seat and per-seat-replay journeys land as Stage 7.8 e2e additions. The host wiring that narrows a live human's `controlledSlots` to their single assigned seat lives in `frontend/src/pages/SessionPage.vue`: it reads the human's seat from the recording header's `players` attribution (the seat whose `kind` is `human`) rather than handing the renderer every human-capable seat, so a human seated anywhere other than seat 0 controls their own seat and their moves and decision-log rows follow it. The move clock likewise uses the session's resolved `human_timeout_ms`, persisted on the session row and overlaid onto the renderer's metadata at mount, not just the environment default.

Part of [Stage 7](../stage-07-multi-agent.md). This is build-order step 7 and the last functional step. It draws Hearts and turns clicks into card plays. It is Docker-free frontend work, tested against fixtures and recordings the way the Stage 4 renderer was, separately from live session control. It depends on the environment state schema from step 1; the live human-slot wiring it drives is exercised by steps 5 and 6.

## Why this is its own seam

Rendering and on-screen input are pure functions of session state, so they test against fixtures and recordings without a live session, mirroring the Stage 4 renderer-versus-live split. Building the renderer last means it draws against the real recorded Hearts state shape that steps 1, 5, and 6 have settled, rather than a guess. The on-screen input UI from [interaction.md](../../docs/specs/interaction.md) replaces raw device input for Hearts.

## What to build

A `hearts` renderer under `environments/hearts/renderer/`, extending the shared Pixi base through the `@renderers` alias and default-exporting its definition for automatic discovery, with a pure `computeScene(state)` like `environments/flappy_bird/renderer/scene.ts`. The renderer is the `renderer="hearts"` key the environment metadata declares in step 1. It serves both the web app and loopback local play, drawing the recorded state and greying cards from the emitted legal-action mask.

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

The browser renderer uses a 960x720 table, an N/E/S/W seat layout with the viewed seat at the bottom, fan geometry, primitive suit pips, card backs, and a status strip with rule hints. Legality greying reads the emitted mask verbatim. The bottom seat is tagged "(you)" and gets the move clock only when the viewer controls it, since a replay's bottom seat is not the viewer.

Animation and replay. The owner asked for the trick-won sweep (and the active-seat glow) to animate in replay too, at replay-time scale, rather than being dropped to keep determinism. So the pure `computeScene` still returns the static "snapped" frame a scrubber lands on, and a thin animation layer rides on top: the shared `PixiRenderer` base gained an optional per-frame loop (an `animated` flag and an `onFrame` hook driven by the PixiJS ticker), and `RendererInstance.render` gained a `RenderOptions` argument. The replay transport now passes that cadence as a transition budget while playing and `snap` on any scrub, step, or seek, so an animated renderer fits its transitions inside the replay cadence and never animates a jump. Flappy Bird is unaffected: it leaves `animated` false and ignores the options, so it stays draw-only.

Card-play fly-in and hover. The owner then asked, so a viewer can tell _which_ card each player sent out, to highlight and fly the played card from its owner into the centre rather than snapping it. So beyond the sweep, every card now animates from the player who played it: when a snapshot adds a card to the trick, the renderer briefly highlights that card where it sat in the player's revealed hand (or an opponent's row), then eases it into its trick spot. The fly-in is a second pure detector + easing pair beside the sweep's (`detectPlay`/`playCardAt` in `scene.ts`), driven by the same per-frame loop; while the card slides, the retained renderer holds the source hand/row at its _previous_ layout, leaving a placeholder gap where the played card was, so the remaining cards do not re-fan until the card lands. Because the fourth card resolves its trick in the same step (`rules.play`), its fly-in chains straight into the sweep, and the two phases are sized from one shared transition budget so the chained pair finishes inside the playback cadence (the next snapshot never cuts the sweep short). The airborne card is drawn on a dedicated layer above the hand fan, so it lifts cleanly off its neighbours instead of being occluded by them. A hover highlight (gold ring + small lift) rides on hand cards only when the hand is interactive, and is absent in replay/spectator, which have no controlled slots. All of this runs in both replay/watch and live play. Replay and scripted watch use the environment's viewing cadence. A live human session renders its leading frame immediately, then gives rapidly streamed moves from other seats the shorter `live_interval_ms` transition budget so they animate one at a time. Environments without that live cadence continue rendering every live frame on arrival at the natural transition length.

Game-over is host chrome, not the renderer's. The end-of-match screen is a cross-environment leaderboard over the renderer host on live, replay, and local pages. It reconstructs multi-seat scores from the overlay's seat-indexed scores and uses shared attribution labels. The renderer keeps only its in-game status message.

Move clock. Per the owner's choice, the renderer draws a deterministic per-move budget chip (the session `human_timeout_ms` in whole seconds) on the controlled human's turn, and nothing in replay or spectator views (where there are no controlled slots). A true ticking countdown, if wanted later, is host chrome that may use the wall clock; the renderer stays a pure function of state plus mount-time config.

## Done when

A Hearts session renders the player's hand, the current trick, a turn indicator, per-slot penalty scores, and the move clock from the session value. Clicking a legal card plays it, and illegal cards are greyed from the environment's emitted legal-action mask, so the browser never recomputes legality. A replay of a multi-agent Hearts match renders trick-by-trick turns and per-slot penalty scores correctly. The jsdom scene and replay tests above pass with no canvas or network.
