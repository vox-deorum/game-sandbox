# Stage 8.1: Spades Environment, Scoring, and Metadata

Status: not started.

Part of [Stage 8](../stage-08-communication.md). This is build-order step 1, the first demonstrable slice, and the foundation every other step attaches to. It is the Spades game itself: a custom four-player partnership environment with its bidding round, its trick play, its team scoring, and its metadata. It is pure Python with no Docker, no backend, and no database, so it runs and tests through the existing single-session loop exactly as Hearts does. The hands-on surface at the end of this step is local play: a full bid-and-thirteen-tricks hand watchable and playable in a pygame window.

## Why this is its own seam

Spades is the product content of the stage, and it is what makes the stage's communication work matter: seats 0 and 2 are partners against seats 1 and 3, so a targeted message to your partner and a broadcast warning to the table are structurally different acts, in a way Hearts' every-seat-for-itself scoring never produced. The template (step 2), the browser renderer (step 3), and the chatting examples (step 4) all consume an environment that already exists and already declares its shape, so it lands first, and it lands complete: the game is fully playable chat-less, and the messaging metadata it declares stays inert until step 4 wires the hook.

Like Hearts, Spades is not in the PettingZoo classic set, so it is implemented as a custom environment against the PettingZoo **AEC** (Agent Environment Cycle) API, the API designed for sequential turn-based games. The Hearts package is the direct model: a dependency-free rules engine, a thin AEC wrapper, an overlay for the browser, and a pygame renderer with interactive play, mirrored file for file.

## What to build

A new top-level environment package under `environments/src/spades/` (importable as `spades`), registered as a `game_sandbox.environments` entry point in `environments/pyproject.toml` and added to the wheel `packages` list, following the [environments contributor guide](../../docs/contributors/environments.md). It mirrors `environments/src/hearts/` file for file: `rules.py`, `env.py`, `overlay.py`, `render.py`, `human.py`, `demo.py`, and an `__init__.py` exporting the standard `EnvironmentEntry` (meta, `make`, `default_action`, overlay).

### Rules to enforce

The environment is authoritative for legality across both phases. One hand per episode, matching the Hearts pattern: a bidding round, then thirteen tricks.

- Each seat bids exactly once, an integer from 0 to 13, where 0 is nil. Seat 0 bids first and leads the first trick; that fixed convention is pinned by a test so the scheduler, examples, and e2e journeys can rely on it. There is no blind or double nil: every bid is made with the hand in view, so the nil stake is always one hundred points.
- During play, follow suit if able.
- Spades may not be led until broken (a spade has been played to an earlier trick), unless the hand holds nothing but spades.
- A trick is won by the highest spade played to it, or by the highest card of the led suit when no spade appears.

A single `legal_actions(state, seat)` helper computes the legal set for the seat on turn in either phase, and the step function rejects an illegal action. The same legal set is surfaced into the recorded session state as a legal-action mask: it travels in the on-turn seat's observation, and it is mirrored into the Spades overlay so both renderers grey from the emitted mask rather than reimplementing the rules, the Stage 7 invariant that keeps the Python environment the single authority on legality.

### Action space

One combined `Discrete(66)` action space covers both phases: actions 0 through 51 are cards, and action `52 + k` is a bid of `k`. The mask selects the phase-legal subset, so during bidding only bid actions are legal and during play only cards are. This keeps the agent interface a single integer everywhere the harness, schema, and recordings already assume one, at the cost of a slightly wider mask.

The `default_action` hook receives only a slot id, with no view of the hand or the phase, so a state-dependent default cannot live in the hook itself. Spades follows the Hearts `AUTO_ACTION` precedent exactly: `default_action` returns a sentinel, and `env.step` resolves the sentinel against the live state. During bidding it resolves to a deterministic heuristic `suggested_bid` derived from the hand, and it **never resolves to nil**, because nil is a deliberate gamble no timeout should impose on a partnership. During play it resolves to the lowest legal card, matching Hearts.

### Partnerships and scoring

Four seats, two partnerships: seats 0 and 2 against seats 1 and 3. Every seat is human-capable, and as in Hearts the metadata bakes in no single-human-seat assumption.

Scoring is the standard single-hand rules, with the variant choices pinned by tests the way Hearts pinned its no-pass variant:

- A team's contract is the sum of its partners' non-nil bids. Making the contract scores ten points per bid trick plus one point per overtrick (bag); failing it scores minus ten per bid trick.
- A nil bid is scored per bidder: a made nil (zero tricks) earns one hundred points, a set nil loses one hundred. A set nil's tricks **count as tricks for the partner**, at which point all the normal rules apply, contract and bags alike; the nil penalty is charged separately. The worked cross-case pins this: a partner who bid 4 and took 3 tricks alongside a set nil that took 2 has a made contract of 4 with 5 team tricks, scoring 40 plus 1 bag minus the 100 nil penalty, a hand total of minus 59.
- When both partners bid nil, the team contract is zero and trivially made, so every trick either set nil takes lands as a bag beside the nil penalties.
- The ten-bag penalty is deliberately omitted: it only matters across accumulated hands, and an episode is a single hand.

The worst achievable team score follows from these rules: both partners bidding 13 makes a contract of 26, which thirteen tricks can never satisfy, so minus 260 is the floor beneath every honest outcome. Step 3 registers that value as the Spades forfeit floor on the backend so a crashed seat can never outrank honest play.

Scores are reported two ways, following the Hearts split between display and ranking:

- **Display scores** show per-seat bids and tricks won plus the two team totals, so the renderers can draw `bid/won` badges and a team score line.
- **Leaderboard scores** are the raw team hand score reported per seat, identical for both partners and higher-is-better, mirroring the raw negated-penalty precedent in `environments/src/hearts/rules.py`. Partners sharing a score is the intended semantics: a seat is ranked by how its team fared.

Rewards are 0.0 during play and the per-seat leaderboard score on the terminal step, so the existing credit loop in `harness/src/game_sandbox_harness/session.py` needs no change. Score leaves use int16, not the int8 that suffices for Hearts penalties, because team scores reach into the hundreds in both directions.

### Observation

The observation follows `hearts/env.py::observe`: a dict of `{"observation": {...}, "action_mask": (66,)}` where the observation carries the seat's hand, a phase flag, the four bids (minus one until a seat has bid), the current trick, the led suit, whether spades are broken, the seat's position, the trick leader, and per-seat tricks won. Everything an agent needs to bid and play is in its own observation; nothing reveals another hand.

### Local Python renderer and interactive play

Spades ships its own pygame renderer and human controller, reusing the Hearts table geometry: the view seat at the bottom, opponents fanned around, the current trick in the centre. On top of that it draws what Spades adds: per-seat `bid/won` badges with a NIL marker, the two team scores styled so the partnership is visually legible, a spades-broken indicator, and a phase indicator. During bidding the renderer draws a clickable row of bid chips 0 through 13 with 0 labelled "NIL", and hit-tests clicks to bids; during play it greys illegal cards from the emitted mask and hit-tests clicks to cards, exactly as Hearts does. `make_env(render_mode=...)` accepts `"human"`, `"rgb_array"`, and `None`, so the renderer stays headlessly testable.

Partners share a leaderboard score by construction, and the local standings in `scripts/play.py::_standings` currently award cups by row position, which would hand tied partners different medals. This step makes that ranking tie-aware with dense ranking: rows with equal scores share a medal, and the next distinct score takes the next medal, so the winning partnership shows two golds and the losing partnership two silvers. Step 3 applies the same rule to the web twin, `frontend/src/lib/standings.ts`.

### Metadata

Populate `EnvironmentMeta` (the Stage 2 type, see [environments and metadata](../stage-02/environments-and-metadata.md)):

- `env_id="spades"`, four slots (`min_slots=4`, `max_slots=4`), and all four seats in `human_slots`.
- Unpaced (`pace_interval_ms=None`), with the Hearts viewing cadences: `view_interval_ms=3000` for watch and replay, `live_interval_ms=900` for live human sessions.
- `human_timeout_ms=60_000`, `step_limit_ms=1_000`, `episode_limit_ms=120_000`, and `recommended_episode_ticks=56` (four bids plus fifty-two plays).
- `renderer="spades"`.
- `seat_order_matters=True`: partnership assignment and lead position both depend on seating, so the Stage 7 scheduler enumerates ordered seatings.
- **`messaging=True`, `message_cap=120`**: Spades is the messaging-enabled environment of this stage, and the cap counts Unicode code points (the rule step 4 pins). Declaring it here is deliberate even though nothing reads it yet: the flag is inert until step 4 wires the chat hook, and declaring it from day one means the environment is touched once and the metadata tests pin the final shape from the start.

Regenerate `backend/src/generated/environments.json` through `scripts/generate.py` so the backend and frontend see the new entry.

## Tests

Pure Python unit tests in the environments package mirroring `environments/tests/test_hearts.py`, no Docker, no DB:

- Bidding legality: every seat bids exactly once in seat order starting at seat 0, card actions are illegal during bidding, and bid actions are illegal during play.
- Play legality: follow-suit, spades-not-led-until-broken (including the all-spades exception), and trick-winner resolution each accept legal play and reject illegal play, and `legal_actions` matches the emitted mask in representative fixtures.
- The scoring matrix: made contract with and without bags, failed contract, made nil, and set nil each produce the worked totals; the set-nil cross-case is pinned exactly (bid 4 with 3 own tricks beside a set nil with 2 scores minus 59, because the nil's tricks make the contract and land a bag); the double-nil edge scores a trivially made zero contract with all tricks as bags; and the ten-bag omission and the minus 260 worst case are pinned.
- Leaderboard scores are identical for both partners, higher-is-better, and consistent with the team totals; score leaves fit int16 values.
- `default_action` returns the sentinel, and `env.step` resolves it to the deterministic `suggested_bid` during bidding, never to nil on any fixture hand, and to the lowest legal card during play.
- The `play.py` standings award dense tie-aware medals: two seats with equal scores share a medal, pinned on a partnership fixture.
- The PettingZoo `api_test` passes, a fixed seed replays deterministically, and the overlay round-trips through JSON.
- The local renderer produces an `rgb_array` frame headlessly for both phases, and the hit-tests map a bid-chip click to the expected `52 + k` and a card click to the expected card.
- `to_json()` carries `seat_order_matters: true`, `messaging: true`, the cap, and all four seats in `human_slots`, and the regenerated `backend/src/generated/environments.json` includes the Spades entry.

## Done when

A full hand of Spades (four bids, thirteen tricks, team scores settled) plays to completion through the existing single-session loop with built-in defaults in all four seats, and the scores match hand-worked examples, the set-nil cross-case included. A student-shaped user can watch that hand locally in a pygame window and play a seat interactively, clicking a bid chip and then legal cards, with illegal actions greyed from the emitted mask, and tied partners share a medal in the local standings. The environment records display scores and partner-identical leaderboard scores, declares its metadata including the inert messaging flag, and is registered so every later step can target it. The Python unit tests above are green with no Docker or DB.
