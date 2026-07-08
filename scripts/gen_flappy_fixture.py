"""One-off generator for the frontend's Flappy Bird renderer test fixture.

Drives a full, seeded single-agent game of Flappy Bird through the real harness recording path
(``run_episode`` + ``FolderRecordingStore``), then copies the produced ``recording.jsonl`` to
``frontend/test/fixtures/flappy-recording.jsonl``. The frontend scene/replay tests read that slice
the same way the Hearts/Spades tests read a real recording: a byte-identical, real-shape input.

Run from the repo root with:  uv run python scripts/gen_flappy_fixture.py
"""

from __future__ import annotations

from typing import Any

from _fixture_common import run_and_copy
from flappy_bird import ENTRY
from game_sandbox_harness.session import AgentSlot
from game_sandbox_harness.state import PlayerAttribution

FLAP = 1
IDLE = 0


class GapChaserAgent:
    """A deterministic heuristic: flap when the bird is predicted below the next gap's center.

    Inlined here so the generator does not depend on the example package layout (mirrors
    ``examples/flappy_bird/hello``). Reads the object observation directly: ``player`` (x, y,
    vel_y, rot) and ``pipes`` (tuple of ``{"x","gap_top","gap_bottom"}``, nearest-first). It
    predicts the bird's position on the next step (``y + vel_y``) and flaps whenever that would
    put it below the target gap center, producing a lively but not-immortal run that clears a
    handful of pipes before eventually colliding — enough to exercise the pipes-passed counter and
    a spread of pipe positions in the recording.
    """

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> int:
        player = observation["player"]
        pipes = observation["pipes"]
        predicted_y = float(player["y"]) + float(player["vel_y"])

        if pipes:
            pipe = pipes[0]
            gap_center = (float(pipe["gap_top"]) + float(pipe["gap_bottom"])) / 2.0
        else:
            gap_center = float(observation["height"]) / 2.0

        return FLAP if predicted_y > gap_center else IDLE


def main() -> int:
    # A submitted-agent attribution for the single slot so the fixture header carries a `players`
    # block like the Hearts/Spades fixtures, without needing a live session.
    players: dict[str, PlayerAttribution] = {
        "player_0": {"kind": "human", "label": "you"},
    }
    slots = {"player_0": AgentSlot(GapChaserAgent())}
    run_and_copy(
        ENTRY,
        slots,
        seed=7,
        recording_id="flappy-fixture",
        dest_name="flappy-recording.jsonl",
        players=players,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
