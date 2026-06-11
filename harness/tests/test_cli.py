"""The cross-package CLI smoke test: the Stage 2 exit criterion in executable form.

It composes the hello example into a full repo (template + overlay, with a manifest), then
runs the harness CLI to play a full seeded Flappy Bird episode and load the agent from that
manifest. This is the one test that crosses all three packages — harness, environments, and
the composed template — and it asserts the written recording validates on read-back.
"""

from __future__ import annotations

import sys
from pathlib import Path

from game_sandbox_harness.cli import main
from game_sandbox_harness.recording.local import FolderRecordingStore

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from compose_example import compose  # noqa: E402


def test_cli_plays_composed_hello_and_records(tmp_path: Path):
    repo = compose("hello")  # full runnable repo under build/examples/hello

    rc = main(
        [
            "--env",
            "flappy_bird",
            "--agent",
            str(repo),
            "--seed",
            "0",
            "--record",
            str(tmp_path),
            "--steps",
            "60",
        ]
    )
    assert rc == 0

    store = FolderRecordingStore(tmp_path)
    ids = store.list_ids()
    assert len(ids) == 1
    recording = store.open(ids[0])
    assert recording.header["environment"] == "flappy_bird"
    assert recording.header["seed"] == 0
    # steps() validates every line against the schema on read-back.
    steps = list(recording.steps())
    assert steps
    assert steps[0]["tick"] == 0
    assert "overlay" in steps[0]
    assert "player_0" in steps[0]["agents"]
