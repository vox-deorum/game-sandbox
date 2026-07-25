"""One-off generator for the frontend's Hearts renderer test fixture.

Drives a full, seeded four-agent game of Hearts through the real harness recording path
(``run_episode`` + ``FolderRecordingStore``), then copies the produced ``recording.jsonl`` to
``frontend/test/fixtures/hearts-recording.jsonl``. The frontend scene/replay tests read that slice
the same way the Flappy Bird tests read a real Flappy recording: a byte-identical, real-shape input.

Run from the repo root with:  uv run python scripts/gen_hearts_fixture.py
"""

from __future__ import annotations

from typing import Any

from _fixture_common import run_and_copy
from game_sandbox_harness.session import AgentPlayer
from game_sandbox_harness.state import PlayerAttribution
from hearts import ENTRY, rules
from local_play.card_utils import HEARTS, SPADES

QUEEN_OF_SPADES_FACE = {"suit": SPADES, "rank": 12}


class DuckAgent:
    """The 'duck' policy (mirrors environments/hearts/examples/duck): avoid taking points.

    Inlined here so the generator does not depend on the example package layout. It produces a
    livelier game than always-lowest-legal, so the fixture exercises hearts breaking, the queen of
    spades changing hands, and a spread of per-player penalty scores.

    Reads the NEW object observation: ``obs["observation"]["current_trick"]`` (tuple of
    ``{"player","card"}`` FACE objects, play order) and ``led_suit`` (int, 4=none). The action mask is
    still indexed by engine card id 0..51, so legal moves are decoded straight from the mask; suit/
    rank comparisons use the FACE values on the hand/trick card objects (queen face rank is 12).
    """

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> int:
        mask = observation["action_mask"]
        legal = [card for card in range(52) if mask[card]]
        state = observation["observation"]
        led = int(state["led_suit"])  # 4 == no card led yet

        def suit_of(card_id: int) -> int:
            return card_id // 13

        def face_rank_of(card_id: int) -> int:
            # FACE rank of an engine card id, so it compares directly against trick card objects.
            return card_id % 13 + 2

        if led == 4:
            return min(legal, key=lambda card: (face_rank_of(card), suit_of(card)))

        followers = [card for card in legal if suit_of(card) == led]
        if followers:
            played = [entry["card"] for entry in state["current_trick"] if entry["card"]["suit"] == led]
            winning_rank = max((card["rank"] for card in played), default=1)
            under = [card for card in followers if face_rank_of(card) < winning_rank]
            if under:
                return max(under, key=face_rank_of)
            return min(followers, key=face_rank_of)

        queen_id = QUEEN_OF_SPADES_FACE["suit"] * 13 + (QUEEN_OF_SPADES_FACE["rank"] - 2)
        if queen_id in legal:
            return queen_id
        hearts = [card for card in legal if suit_of(card) == HEARTS]
        if hearts:
            return max(hearts, key=face_rank_of)
        return max(legal, key=face_rank_of)


def main() -> int:
    # A submitted-agent attribution per player so the fixture header carries a `players` block like a
    # real multi-agent recording (player_0 a "human", the rest agents) without needing a live session.
    player_attribution: dict[str, PlayerAttribution] = {
        "player_0": {"kind": "human", "label": "you"},
        "player_1": {"kind": "agent", "label": "Naive agent"},
        "player_2": {"kind": "agent", "label": "Naive agent"},
        "player_3": {"kind": "agent", "label": "duck-hearts"},
    }
    players = {f"player_{i}": AgentPlayer(DuckAgent()) for i in range(rules.NUM_PLAYERS)}
    run_and_copy(
        ENTRY,
        players,
        seed=7,
        recording_id="hearts-fixture",
        dest_name="hearts-recording.jsonl",
        player_attribution=player_attribution,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
