"""One-off generator for the frontend's Spades renderer test fixture.

Drives a full, seeded four-agent game of Spades through the real harness recording path
(``run_episode`` + ``FolderRecordingStore``), then copies the produced ``recording.jsonl`` to
``frontend/test/fixtures/spades-recording.jsonl``. The frontend scene/replay tests read that slice
the same way the Hearts tests read a real Hearts recording: a byte-identical, real-shape input that
carries the opening bidding round (four bidding states) and all thirteen tricks.

Run from the repo root with:  uv run python scripts/gen_spades_fixture.py
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentSlot, run_episode
from game_sandbox_harness.state import PlayerAttribution
from spades import ENTRY, rules


class SuggestedBidAgent:
    """A deterministic naive policy: the suggested (never-nil) bid, then the lowest legal card.

    Inlined here so the generator does not depend on the example package layout. During bidding it
    decodes the hand from the observation and returns :func:`rules.suggested_bid` encoded as a bid
    action; during play it returns the lowest legal card id. This mirrors the environment's own
    timeout default (:func:`rules.resolve_auto_action`), so the fixture is a lively but predictable
    hand exercising bids, spades breaking, and a spread of team scores. It never bids nil, so the NIL
    badge path is covered by synthetic unit fixtures rather than this recording.
    """

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> int:
        mask = observation["action_mask"]
        state = observation["observation"]
        legal = [action for action in range(rules.ACTION_SPACE_SIZE) if mask[action]]
        if any(rules.action_is_bid(action) for action in legal):
            hand = [card for card in range(rules.NUM_CARDS) if state["hand"][card]]
            return rules.bid_to_action(rules.suggested_bid(hand))
        # Play phase: the lowest legal card (rank then suit), matching the timeout default.
        cards = [action for action in legal if action < rules.NUM_CARDS]
        return min(cards, key=lambda card: (rules.rank_of(card), rules.suit_of(card)))


def main() -> int:
    seed = 7
    # A submitted-agent attribution per slot so the fixture header carries a `players` block like a
    # real multi-agent recording (player_0 a "human", the rest agents) without needing a live session.
    players: dict[str, PlayerAttribution] = {
        "player_0": {"kind": "human", "label": "you"},
        "player_1": {"kind": "agent", "label": "Naive agent"},
        "player_2": {"kind": "agent", "label": "Naive agent"},
        "player_3": {"kind": "agent", "label": "Naive agent"},
    }
    slots = {f"player_{i}": AgentSlot(SuggestedBidAgent()) for i in range(rules.NUM_PLAYERS)}

    with tempfile.TemporaryDirectory() as tmp:
        store = FolderRecordingStore(tmp)
        result = run_episode(
            ENTRY,
            slots,
            seed=seed,
            store=store,
            recording_id="spades-fixture",
            players=players,
        )
        src = Path(tmp) / "spades-fixture" / "recording.jsonl"
        dest = (
            Path(__file__).resolve().parents[1] / "frontend" / "test" / "fixtures" / "spades-recording.jsonl"
        )
        shutil.copyfile(src, dest)
        print(f"wrote {dest} ({result.ticks} ticks, reason={result.reason})")
        print(f"final scores: {result.scores}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
