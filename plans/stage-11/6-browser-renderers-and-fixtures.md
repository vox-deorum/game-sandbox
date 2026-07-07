# Stage 11.6: Browser Renderers and Recorded Fixtures

Status: not started.

Part of [Stage 11](../stage-11-semantic-contract.md). This is build-order step 6. The Pixi renderers learn to read object-shaped overlays and normalize card objects back to integers at one boundary, and the recorded fixtures the frontend tests replay are regenerated on the new overlay shape, including a Flappy Bird fixture generator that has never existed. Sent actions stay integer indices — the action encoding is unchanged — so nothing in the send path or the decision log changes. The hands-on surface is the browser: watch, play, and replay all three games in the web app over the object-shaped overlay.

## Why this is its own seam

The browser is the second consumer of the overlay contract (the pygame twin converted inside steps 2 through 4), and the overlay is the recorded artifact, so its shape change ripples into the replay/playback fixtures. Because the action stays an integer index — a card click sends a card id, a bid chip sends `52 + k`, a tap sends `1` — the WebSocket send path, the relay, the recording pipeline, and `formatAction` are all untouched. This step touches only the renderer overlay-read boundary and the fixtures.

## What to build

### One read boundary, int-keyed internals

`frontend/src/renderers/cards/scene.ts` keeps its integer card codec (`suitOf`, `rankOf`, `RANK_LABELS`) for geometry, animation, and hit-testing, and gains the pair `cardFromObj` and `cardToObj` matching the Python codec (integer suit `0..3`, rank `2..14`, so `{suit: 2, rank: 12}` ↔ int 36). `readCardOverlay` becomes the single normalization point: it parses an object-shaped hand (a list of `{suit, rank}` objects) and a play-ordered trick (a list of `{seat, card}` records), maps `led_suit` (`0..3`, or `4` for none) to the int-keyed form the draw code expects, and produces the int-keyed structures the existing geometry, animation, and legal-greying code already consumes.

On top of that boundary: `hearts/scene.ts` changes only its overlay read (constants like `QUEEN_OF_SPADES = 36` keep working on normalized ints); `spades/scene.ts` changes its overlay read for the object-shaped hand/tricks and reads `bids` with the `14 = unbid` sentinel — but keeps `BID_OFFSET`/`bidToAction` on the **send** side, because a bid chip still sends the integer action `52 + k`; `flappy-bird/index.ts` still sends `1` to flap. The card tap still sends the bare card id. `frontend/src/lib/format.ts` is unchanged (actions remain integers the decision log already renders).

### Recorded fixtures

The inline agents inside `scripts/gen_hearts_fixture.py` and `scripts/gen_spades_fixture.py` are updated to read the object-shaped observation (a hand of card objects, the `action_mask` for legality) while still returning integer actions, and a new `scripts/gen_flappy_fixture.py` drives a scripted flap policy through `run_episode` the same way, closing the gap where the Flappy Bird fixture had no generator. The generator is the new artifact: `frontend/test/fixtures/flappy-recording.jsonl` already exists (committed, on the old overlay shape), so this step **overwrites** it rather than creating it. All three regenerate `frontend/test/fixtures/{hearts,spades,flappy}-recording.jsonl`, whose recorded overlays now carry the object shape and whose recorded actions stay integers; every test that replays the old-shape flappy fixture (the `playback.test.ts`/`replay.test.ts` set below) is updated in the same pass so no old-shape recording lingers.

## Tests

Frontend unit tests update where they construct overlays: `scene.test.ts`, `hearts-scene.test.ts`, `spades-scene.test.ts`, `cards-shared.test.ts`, `input.test.ts`, `playback.test.ts`, `replay.test.ts`, and `session.test.ts`. New pins worth calling out:

- `cardFromObj` and `cardToObj` round-trip all 52 cards and agree with the documented worked example (queen of spades is `{"suit": 2, "rank": 12}`, int 36).
- `readCardOverlay` maps a play-ordered `{seat, card}` trick to the same scene the old shape produced, maps `led_suit` `0..3`/`4` to the internal form, and reads the object-shaped hand.
- A card tap still emits the card id and a bid chip still emits `52 + k` on the session send path (unchanged).
- The replay and playback suites run green against the regenerated fixtures, proving the recording format carries the object-shaped overlay and integer actions end to end.

## Done when

All three games are watchable, playable, and replayable in the browser on the object-shaped overlay: cards grey from the `action_mask`, a click sends the card id, bid chips bid, the tap flaps. The regenerated fixtures are committed, the fixture generators run clean, and the frontend unit suite is green.
