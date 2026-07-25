"""Shared scaffolding for the one-off frontend fixture generators.

``gen_hearts_fixture.py``, ``gen_spades_fixture.py``, and ``gen_flappy_fixture.py`` each drive a
seeded episode through the real harness recording path and copy the produced ``recording.jsonl`` into
``frontend/test/fixtures/``. Everything but the per-game agents and player attribution is identical,
so the run-record-copy step lives here once rather than being restated in each generator.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from game_sandbox_harness.environment import EnvironmentEntry, resolve_parameters
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentPlayer, run_episode
from game_sandbox_harness.state import PlayerAttribution

#: The frontend fixtures directory the generators write into (repo-root relative).
FIXTURES_DIR = Path(__file__).resolve().parents[1] / "frontend" / "test" / "fixtures"


def run_and_copy(
    entry: EnvironmentEntry,
    slots: dict[str, AgentPlayer],
    *,
    seed: int,
    recording_id: str,
    dest_name: str,
    players: dict[str, PlayerAttribution],
) -> None:
    """Run a seeded episode into a temp store, copy its recording to ``FIXTURES_DIR / dest_name``.

    Mirrors what a real recorded session produces, so the copied ``recording.jsonl`` is a
    byte-identical, real-shape input for the frontend scene/replay tests.
    """
    with tempfile.TemporaryDirectory() as tmp:
        store = FolderRecordingStore(tmp)
        result = run_episode(
            entry,
            slots,
            seed=seed,
            parameters=resolve_parameters(entry.meta),
            store=store,
            recording_id=recording_id,
            player_attribution=players,
        )
        dest = FIXTURES_DIR / dest_name
        shutil.copyfile(Path(tmp) / recording_id / "recording.jsonl", dest)
        print(f"wrote {dest} ({result.ticks} ticks, reason={result.reason})")
        print(f"final scores: {result.scores}")
