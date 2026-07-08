"""One-off generator for the frontend's Spades renderer test fixture.

Drives a full, seeded four-agent game of Spades through the real harness recording path
(``run_episode`` + ``FolderRecordingStore``), then copies the produced ``recording.jsonl`` to
``frontend/test/fixtures/spades-recording.jsonl``. The frontend scene/replay tests read that slice
the same way the Hearts tests read a real Hearts recording: a byte-identical, real-shape input that
carries the opening bidding round (four bidding states) and all thirteen tricks.

Run from the repo root with:  uv run python scripts/gen_spades_fixture.py
"""

from __future__ import annotations

from typing import Any

from _fixture_common import run_and_copy
from game_sandbox_harness.session import AgentSlot
from game_sandbox_harness.state import PlayerAttribution
from local_play.card_utils import card_from_obj
from spades import ENTRY, rules


class SuggestedBidAgent:
    """A deterministic naive policy: the suggested (never-nil) bid, then the lowest legal card.

    Inlined here so the generator does not depend on the example package layout. During bidding it
    decodes the hand from the NEW object observation and returns :func:`rules.suggested_bid` encoded
    as a bid action; during play it returns the lowest legal card id. This mirrors the environment's
    own timeout default (:func:`rules.resolve_auto_action`), so the fixture is a lively but
    predictable hand exercising bids, spades breaking, and a spread of team scores. It never bids
    nil, so the NIL badge path is covered by synthetic unit fixtures rather than this recording.

    ``rules.suggested_bid`` compares on ENGINE rank (queen = 10), not the FACE value (queen = 12) the
    object observation carries — so the seat's hand objects are converted back to engine ids via
    :func:`card_from_obj` before being handed to the rules engine. The action mask stays indexed by
    engine action ids (cards 0..51, bids 52..65) regardless of the observation shape, so legal-action
    decoding and the lowest-card fallback are unchanged.
    """

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> int:
        mask = observation["action_mask"]
        state = observation["observation"]
        legal = [action for action in range(rules.ACTION_SPACE_SIZE) if mask[action]]
        if any(rules.action_is_bid(action) for action in legal):
            hand = [card_from_obj(card) for card in state["hand"]]
            return rules.bid_to_action(rules.suggested_bid(hand))
        # Play phase: the lowest legal card (rank then suit), matching the timeout default.
        cards = [action for action in legal if action < rules.NUM_CARDS]
        return min(cards, key=lambda card: (rules.rank_of(card), rules.suit_of(card)))


def main() -> int:
    # A submitted-agent attribution per slot so the fixture header carries a `players` block like a
    # real multi-agent recording (player_0 a "human", the rest agents) without needing a live session.
    players: dict[str, PlayerAttribution] = {
        "player_0": {"kind": "human", "label": "you"},
        "player_1": {"kind": "agent", "label": "Naive agent"},
        "player_2": {"kind": "agent", "label": "Naive agent"},
        "player_3": {"kind": "agent", "label": "Naive agent"},
    }
    slots = {f"player_{i}": AgentSlot(SuggestedBidAgent()) for i in range(rules.NUM_PLAYERS)}
    run_and_copy(
        ENTRY,
        slots,
        seed=7,
        recording_id="spades-fixture",
        dest_name="spades-recording.jsonl",
        players=players,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
