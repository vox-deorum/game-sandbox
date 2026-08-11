# Step 6: Human play, the visitor

Status: planned.

Part of [the plan](../README.md). This build-order step puts the visitor seat in human hands by implementing the input UI [specified in step 5.2](5-2-hud-interaction-and-camera.md). Review both live browser play against a running cast and local play.

## What to build

### Locomotion and expression

Compose pointer and keyboard input into heading and relative speed once per input window. The 250 millisecond cadence is the only move clock.

Implement the approved palette of nine emotes plus use. The use preview is informational and uses the environment's reach-plus-unblocked-line selection rule. Chat has one host-panel text field and a recipient selector. It offers Broadcast plus currently permitted character-id addressees. A broadcast or direct line reaches only characters within hearing range with an unblocked line.

The authoritative delivery and visibility rules are in [the environment speech contract](../environment.md#speech). The visitor sees broadcasts delivered to it and direct lines sent to or from it. Watchers and replay viewers see all delivered lines. Spectators and replay viewers have no input.

### Session behavior

Step 1's human-session idle rule must not reclaim a connected visitor who is quietly watching. Arm the timeout only after the last owner socket disconnects. Spectators do not keep the visitor session alive, and scripted watch sessions remain viewer-based. Standing still is normal play.

### Local parity

Make the visitor playable through `scripts/play.py` and the template launcher, both resolving `player_0` in every plan.

## Tests

- jsdom tests cover input composition, palette state, fixture-based preview correctness, recipient selection, broadcast and direct sends, range and wall policy changes, and visitor, watcher, and replay visibility.
- A Playwright journey joins as visitor, walks, emotes, checks the preview, sends a broadcast and a direct line, and sees only broadcasts delivered to it and direct lines sent to or from it. Watcher and replay coverage checks complete delivered transcripts.
- Local-launcher coverage exercises the visitor seat.
- Integration coverage keeps a quiet connected visitor live, arms the idle timeout after the final owner disconnects, and confirms a lone spectator does not extend it.
- Run the Three Branches browser e2e group while iterating. Before handoff, run the bare full browser e2e suite.

## Done when

A human plays the visitor live and locally with the designed locomotion, palette, preview, and chat. A quiet connected visitor is never reclaimed, and the bare full browser e2e suite passes.
