# Stage 8.1: Spades Environment, Scoring, and Metadata

Status: done. The custom PettingZoo AEC Spades environment ships, mirroring the Hearts package file for file: a dependency-free rules engine (a bidding round with seat 0 opening, follow-suit and spades-not-led-until-broken play with the all-spades escape, and trick resolution by highest spade or highest card of the led suit), a single `Discrete(66)` action space where actions 0 to 51 are cards and `52 + k` is a bid of `k`, and team contract, bag, and nil scoring with a set nil's tricks counted for the partnership and the ten-bag penalty omitted. A raw team score is surfaced per seat as the higher-is-better leaderboard score, so partners share it. Metadata declares `seat_order_matters=true` plus the `messaging=true`/`message_cap=120` flags left inert until step 4, and a `default_action(env, slot_id)` hook that returns the real, legal integer played on a timeout. The on-turn observation carries the action mask and the completed trick with its winner alongside the live trick. Browser local play provides interactive bids and cards through the shared loopback runner. The environment is registered as a `game_sandbox.environments` entry point and picked up in the generated `backend/src/generated/environments.json`. The Docker-free pytest suite covers the rules, scoring, masks, completed-trick observation, metadata serialization, the default action, determinism, and a full game through the harness; all green with no Docker or DB.

Part of [Stage 8](../stage-08-communication.md). This is build-order step 1, the first demonstrable slice, and the foundation every other step attaches to. It is the Spades game itself: a custom four-player partnership environment with its bidding round, trick play, team scoring, and metadata. It is pure Python with no Docker, no backend, and no database. The hands-on surface is browser local play through the shared loopback runner.

## Why this is its own seam

Spades is the product content of the stage, and it is what makes the stage's communication work matter: seats 0 and 2 are partners against seats 1 and 3, so a targeted message to your partner and a broadcast warning to the table are structurally different acts, in a way Hearts' every-seat-for-itself scoring never produced. The template (step 2), the browser renderer (step 3), and the chatting examples (step 4) all consume an environment that already exists and already declares its shape, so it lands first, and it lands complete: the game is fully playable chat-less, and the messaging metadata it declares stays inert until step 4 wires the hook.

Like Hearts, Spades is not in the PettingZoo classic set, so it is implemented as a custom environment against the PettingZoo **AEC** (Agent Environment Cycle) API, the API designed for sequential turn-based games. The Hearts package is the direct model: a dependency-free rules engine, a thin AEC wrapper, and an overlay for the browser.

## What to build

A top-level environment package under `environments/spades/` (importable as `spades`), discovered by `npm run sync:envs`, which generates its `game_sandbox.environments` entry point and wheel inclusion, following the [environments contributor guide](../../docs/contributors/environments/). Its maintained modules are `rules.py`, `env.py`, `overlay.py`, and an `__init__.py` exporting the standard `EnvironmentEntry` (meta, `make`, `default_action`, overlay). Browser rendering and local input use the shared frontend and loopback runner.

### Rules to enforce

The environment is authoritative for legality across both phases. One hand per episode, matching the Hearts pattern: a bidding round, then thirteen tricks.

- Each seat bids exactly once, an integer from 0 to 13, where 0 is nil. Seat 0 bids first and leads the first trick; that fixed convention is pinned by a test so the scheduler, examples, and e2e journeys can rely on it. There is no blind or double nil: every bid is made with the hand in view, so the nil stake is always one hundred points.
- During play, follow suit if able.
- Spades may not be led until broken (a spade has been played to an earlier trick), unless the hand holds nothing but spades.
- A trick is won by the highest spade played to it, or by the highest card of the led suit when no spade appears.

A single `legal_actions(state, seat)` helper computes the legal set for the seat on turn in either phase, and the step function rejects an illegal action. The same legal set is surfaced into the recorded session state as a legal-action mask: it travels in the on-turn seat's observation, and it is mirrored into the Spades overlay so the browser renderer greys from the emitted mask rather than reimplementing the rules, the Stage 7 invariant that keeps the Python environment the single authority on legality.

### Action space

One combined `Discrete(66)` action space covers both phases: actions 0 through 51 are cards, and action `52 + k` is a bid of `k`. The mask selects the phase-legal subset, so during bidding only bid actions are legal and during play only cards are. This keeps the agent interface a single integer everywhere the harness, schema, and recordings already assume one, at the cost of a slightly wider mask.

The `default_action(env, slot_id)` hook receives the live environment and the slot id, so it reads the hand and phase and returns the real, legal integer that is applied and recorded — no sentinel resolution in `env.step`. During bidding it returns a deterministic heuristic `suggested_bid` derived from the hand, and it **never returns nil**, because nil is a deliberate gamble no timeout should impose on a partnership. During play it returns the lowest legal card, matching Hearts.

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
- **Leaderboard scores** are the raw team hand score reported per seat, identical for both partners and higher-is-better, mirroring the raw negated-penalty precedent in `environments/hearts/rules.py`. Partners sharing a score is the intended semantics: a seat is ranked by how its team fared.

Rewards are 0.0 during play and the per-seat leaderboard score on the terminal step, so the existing credit loop in `harness/src/game_sandbox_harness/session.py` needs no change. Score leaves use int16, not the int8 that suffices for Hearts penalties, because team scores reach into the hundreds in both directions.

### Observation

The observation follows `hearts/env.py::observe` and the semantic card contract: a dict of `{"observation": {...}, "action_mask": (66,)}` where the inner observation is object-shaped — the seat's hand as card objects `{"suit", "rank"}`, the `seat` and its `partner_seat`, a phase flag, the four bids (`14` until a seat has bid), the running `team_scores` projection, the play-ordered current trick, the play-ordered last completed trick with its winner, the led suit (`4` when none is led), whether spades are broken, the trick leader, and per-seat tricks won. Everything an agent needs to bid and play is in its own observation; nothing reveals another hand.

### Browser local play

Spades supplies semantic overlay data and a legal-action mask to the browser renderer. The shared loopback runner and browser page let a student choose a seat, click a bid chip or legal card, and send the resulting integer action through the same live protocol as a session. The renderer draws bid and score information, and greys illegal cards from the emitted mask.

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

Pure Python unit tests under `environments/spades/tests/` mirroring `environments/hearts/tests/test_hearts.py`, no Docker, no DB:

- Bidding legality: every seat bids exactly once in seat order starting at seat 0, card actions are illegal during bidding, and bid actions are illegal during play.
- Play legality: follow-suit, spades-not-led-until-broken (including the all-spades exception), and trick-winner resolution each accept legal play and reject illegal play, and `legal_actions` matches the emitted mask in representative fixtures.
- The scoring matrix: made contract with and without bags, failed contract, made nil, and set nil each produce the worked totals; the set-nil cross-case is pinned exactly (bid 4 with 3 own tricks beside a set nil with 2 scores minus 59, because the nil's tricks make the contract and land a bag); the double-nil edge scores a trivially made zero contract with all tricks as bags; and the ten-bag omission and the minus 260 worst case are pinned.
- Leaderboard scores are identical for both partners, higher-is-better, and consistent with the team totals; score leaves fit int16 values.
- `default_action(env, slot_id)` returns the deterministic `suggested_bid` during bidding, never nil on any fixture hand, and the lowest legal card during play.
- The `play.py` standings award dense tie-aware medals: two seats with equal scores share a medal, pinned on a partnership fixture.
- The PettingZoo `api_test` passes, a fixed seed replays deterministically, and the overlay round-trips through JSON.
- Browser scene tests cover both phases, and interaction tests map a bid-chip click to the expected `52 + k` and a card click to the expected card.
- `to_json()` carries `seat_order_matters: true`, `messaging: true`, the cap, and all four seats in `human_slots`, and the regenerated `backend/src/generated/environments.json` includes the Spades entry.

## Done when

A full hand of Spades (four bids, thirteen tricks, team scores settled) plays to completion through the existing single-session loop with built-in defaults in all four seats, and the scores match hand-worked examples, the set-nil cross-case included. A student-shaped user can watch that hand locally in the browser and play a seat interactively, clicking bid chips and legal cards with illegal actions greyed from the emitted mask. The environment records display scores and partner-identical leaderboard scores, declares its metadata including the inert messaging flag, and is registered so every later step can target it. The Python unit tests above are green with no Docker or DB.
