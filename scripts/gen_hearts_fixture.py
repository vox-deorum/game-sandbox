"""One-off generator for the frontend's Hearts renderer test fixture.

Drives a full, seeded four-agent game of Hearts through the real harness recording path
(``run_episode`` + ``FolderRecordingStore``), then copies the produced ``recording.jsonl`` to
``frontend/test/fixtures/hearts-recording.jsonl``. The frontend scene/replay tests read that slice
the same way the Flappy Bird tests read a real Flappy recording: a byte-identical, real-shape input.

Run from the repo root with:  uv run python scripts/gen_hearts_fixture.py
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentSlot, run_episode
from game_sandbox_harness.state import PlayerAttribution
from hearts import ENTRY, rules

CLUBS, DIAMONDS, SPADES, HEARTS = 0, 1, 2, 3
QUEEN_OF_SPADES = 36


def _suit(card: int) -> int:
    return card // 13


def _rank(card: int) -> int:
    return card % 13


class DuckAgent:
    """The 'duck' policy (mirrors examples/hearts/duck): avoid taking points.

    Inlined here so the generator does not depend on the example package layout. It produces a
    livelier game than always-lowest-legal, so the fixture exercises hearts breaking, the queen of
    spades changing hands, and a spread of per-seat penalty scores.
    """

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> int:
        mask = observation["action_mask"]
        legal = [card for card in range(52) if mask[card]]
        state = observation["observation"]
        led = int(state["led_suit"][0])
        trick = [int(card) for card in state["trick"]]

        if led == -1:
            return min(legal, key=lambda card: (_rank(card), _suit(card)))

        followers = [card for card in legal if _suit(card) == led]
        if followers:
            played = [card for card in trick if card != -1 and _suit(card) == led]
            winning_rank = max((_rank(card) for card in played), default=-1)
            under = [card for card in followers if _rank(card) < winning_rank]
            if under:
                return max(under, key=_rank)
            return min(followers, key=_rank)

        if QUEEN_OF_SPADES in legal:
            return QUEEN_OF_SPADES
        hearts = [card for card in legal if _suit(card) == HEARTS]
        if hearts:
            return max(hearts, key=_rank)
        return max(legal, key=_rank)


def main() -> int:
    seed = 7
    # A submitted-agent attribution per slot so the fixture header carries a `players` block like a
    # real multi-agent recording (player_0 a "human", the rest agents) without needing a live session.
    players: dict[str, PlayerAttribution] = {
        "player_0": {"kind": "human", "label": "you"},
        "player_1": {"kind": "agent", "label": "Naive agent"},
        "player_2": {"kind": "agent", "label": "Naive agent"},
        "player_3": {"kind": "agent", "label": "duck-hearts"},
    }
    slots = {f"player_{i}": AgentSlot(DuckAgent()) for i in range(rules.NUM_PLAYERS)}

    with tempfile.TemporaryDirectory() as tmp:
        store = FolderRecordingStore(tmp)
        result = run_episode(
            ENTRY,
            slots,
            seed=seed,
            store=store,
            recording_id="hearts-fixture",
            players=players,
        )
        src = Path(tmp) / "hearts-fixture" / "recording.jsonl"
        dest = (
            Path(__file__).resolve().parents[1]
            / "frontend"
            / "test"
            / "fixtures"
            / "hearts-recording.jsonl"
        )
        shutil.copyfile(src, dest)
        print(f"wrote {dest} ({result.ticks} ticks, reason={result.reason})")
        print(f"final scores: {result.scores}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
