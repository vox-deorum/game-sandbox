# Stage 7.1: Hearts Environment, Scoring, and Metadata

Status: done. The Hearts PettingZoo AEC environment ships: a dependency-free rules engine (follow suit, hearts-not-led-until-broken, the first-trick penalty restriction, the two-of-clubs opening lead, and a single legal-move helper), native penalty scoring with the shoot-the-moon flip, the negated-penalty normalized leaderboard score, a legal-action mask carried in both the observation and the render overlay, `seat_order_matters=true` metadata with four turn-based slots, separate watch and live-human viewing cadences, and messaging disabled, a `default_action(env, slot_id)` hook that returns the real lowest-legal-card integer played on a timed-out slot (so the recording holds the actual move, not a sentinel), and a pygame local renderer with click-to-play behind `play.py`. The Docker-free pytest suite covers the rules, scoring, moon flip, normalized score, the mask-versus-rules agreement, the `to_json()` metadata round-trip, the default action, a headless renderer frame and hit-test, determinism, and a full game; all green with no Docker or DB.

Part of [Stage 7](../stage-07-multi-agent.md). This is build-order step 1, the first demonstrable slice, and the foundation every other step attaches to. It is the Hearts game itself: a custom four-player environment with its rules, its scoring, and its metadata. It is pure Python with no Docker, no backend, and no database, so it runs and tests through the existing single-session loop exactly as Flappy Bird does.

## Why this is its own seam

Hearts is the product content of the stage. The harness multi-slot path (step 5), the renderer (step 7), and the scheduler (step 3) all consume an environment that already exists and already declares its shape. Building the environment first means every later step has a real four-slot, turn-based, positional environment to run against instead of a stub. The rules engine is also the single source of legal moves, which the renderer reuses to grey illegal cards, so it must land before the UI.

Hearts is not in the PettingZoo classic set, so it is implemented as a custom environment against the PettingZoo **AEC** (Agent Environment Cycle) API, the API designed for sequential turn-based games.

## What to build

A new top-level environment package under `environments/src/hearts/` (importable as `hearts`), registered as a `game_sandbox.environments` entry point in `environments/pyproject.toml` and added to the wheel `packages` list, mirroring `flappy_bird/__init__.py`. It exposes the standard `EnvironmentEntry` (meta, `make`, `default_action`, optional `overlay`).

### Rules to enforce

The environment is authoritative for legality. It enforces:

- Follow suit if able.
- Hearts may not be led until broken.
- The two of clubs leads the first trick.
- No hearts or queen of spades on the first trick.
- The no-pass variant of Hearts, so the opening three-card pass is not modeled as a separate decision round. Note the pass as a deferred follow-up, since it is itself an interesting multi-agent signaling moment that Stage 8 may want.

A single `legal_moves(state, slot)` helper computes the legal card set for the slot on turn, and the step function rejects an illegal action. The same legal set is surfaced into the recorded session state as a legal-action mask: it travels in the on-turn slot's observation, because the agent needs it to choose a move, and it is mirrored into the Hearts overlay so the browser renderer can read it. The renderer (step 7) greys illegal cards from that emitted mask rather than reimplementing the rules in JavaScript, so the Python environment stays the single authority on legality and the browser cannot disagree with it.

### Slots and scoring

Four slots. One connected human can occupy one slot and submitted agents fill the rest, but the slot metadata and session assignment must not assume Hearts can only ever have one human-controlled seat.

Scoring is penalty-based and reported two ways:

- **Native penalty score** for display: each heart is one point, the queen of spades is thirteen, and a lower total is better. Shooting the moon (taking every heart and the queen) flips to zero for the shooter and twenty-six for everyone else. The renderer shows these native penalty scores per slot.
- **Normalized leaderboard score** for ranking: a higher-is-better value such as the negative penalty total, so the Stage 6 board keeps its higher-is-better rule unchanged.

Per-slot display scores and leaderboard scores must both be present in the recorded state so they render and replay correctly where they appear.

### Local Python renderer and interactive play

Hearts is a custom environment, so unlike Flappy Bird it does not inherit a renderer from a wrapped Gymnasium game. It implements its own Python-based renderer so a student can run the game locally and see it, not just read a score. `make_env(render_mode=...)` accepts `"human"`, `"rgb_array"`, and `None`, the env advertises those in its PettingZoo `metadata["render_modes"]`, and `render()` draws the player's hand, the current trick, a turn indicator, and the running per-slot penalty scores. It uses the same library the existing render path already pulls in (pygame). This is the renderer the template's local `play.py` opens when a student runs `python play.py` against the synced `sandbox/env/`, exactly as Flappy Bird does today through `make_env(render_mode="human")`.

Because Hearts is turn-based with a small, discrete legal-move set, the local renderer also supports interactive play. It hit-tests a mouse click against the drawn hand and returns the selected card, greying illegal cards from the same emitted legal-action mask, so a student can take a seat and play a full hand against the built-in agents locally. The interactive play loop that occupies a seat with that input ships with the template (step 2); the renderer and its click hit-testing live here in the environment. This local Python renderer is separate from and complementary to the browser renderer (step 7): both draw the same recorded state and grey from the same legal-action mask, so they stay consistent, but one runs in pygame for local testing and the other in the web app.

### Metadata

Populate `EnvironmentMeta` (the Stage 2 type, see [environments and metadata](../stage-02/environments-and-metadata.md)):

- Four slots: `min_slots=4`, `max_slots=4`.
- `human_slots=("player_0", "player_1", "player_2", "player_3")`: every seat is human-capable, because a positional Hearts seat is playable by a person, so the play flow can truthfully offer any seat to the connected human. The metadata bakes in no single-human-seat assumption. This stage still runs exactly one connected human, but that is a session-composition limit enforced in the play flow (step 6) and start validation (step 4), not a metadata one, so later multi-human play attaches more connected users without a metadata change.
- `pace_interval_ms=None`: Hearts runs the turn-based path, advancing as each slot acts, with no pace interval.
- `view_interval_ms=3000`: the watch/replay playback cadence. Independent of the (absent) pace interval, so the turn-based stepping and human deadline are untouched; it only slows how fast a spectator's watch run or a replay plays each move out, so the cards are followable. The frontend reads it after `pace_interval_ms` and falls back to its own default when both are unset.
- `live_interval_ms=900`: the live human-session cadence for playing other seats' rapidly streamed moves one at a time. The human's own move still renders as soon as it arrives. This affects only browser presentation, not turn-based stepping, the human move clock, or scoring, and is intentionally quicker than the watch/replay cadence.
- `renderer="hearts"`.
- `seat_order_matters=True`: Hearts is a positional trick-taking game, so seating agent A before B is not the same match as B before A. This is the existing boolean on `EnvironmentMeta`, serialized snake_case through `to_json()` like the other fields. The multi-seat scheduler (step 3) is its only consumer for now.
- Messaging flag disabled, and it stays disabled: Stage 8 builds Spades as its messaging test bed rather than enabling chat on Hearts.

### Timeout default action

`default_action` returns a legal default for a timed-out human-controlled slot, for example the lowest legal card. The harness invokes it on a human-slot timeout (step 5); the renderer shows the move clock (step 7).

## Tests

Pure Python unit tests in the environments package, no Docker, no DB:

- Rule enforcement: follow-suit, hearts-not-led-until-broken, two-of-clubs opening lead, and the first-trick no-hearts/no-queen restriction each accept legal play and reject illegal play.
- `legal_moves` returns exactly the legal set in representative mid-trick, first-trick, and hearts-broken states, and that same set appears as the legal-action mask in the recorded observation and Hearts overlay.
- Scoring: a normal hand produces the right per-slot penalty totals; a shoot-the-moon hand flips to zero for the shooter and twenty-six for the others.
- The normalized leaderboard score is higher-is-better and consistent with the native penalty totals.
- The local renderer produces a frame in `rgb_array` mode for a representative state without opening a window, so it is testable headlessly; `metadata["render_modes"]` advertises `human` and `rgb_array`; and the click hit-test maps a window position to the expected card. The `human` pygame window itself is exercised manually, not in CI.
- `to_json()` carries `seat_order_matters: true`, all four seats in `human_slots`, and the four-slot, turn-based metadata, and the generated `backend/src/generated/environments.json` includes the Hearts entry.

## Done when

A full game of Hearts plays to completion through the existing single-session loop with built-in agents in all four slots. The environment enforces every rule above, rejects illegal cards, and records both per-slot native penalty scores and the normalized leaderboard score. A student can run `python play.py` against the Hearts template and watch a game in a render window, and play a hand interactively by clicking legal cards, all locally with no backend. `EnvironmentMeta` declares four turn-based slots with `seat_order_matters=true`, separate watch and live-human viewing cadences, messaging disabled, and a `default_action` that returns a legal card. The Python unit tests above are green with no Docker or DB, and the environment is registered so the rest of the stage can target it.
