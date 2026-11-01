"""The cross-package CLI smoke test: the Stage 2 exit criterion in executable form.

It composes the hello example into a full repo (template + overlay, with a manifest), then
runs the harness CLI to play a full seeded Flappy Bird episode and load the agent from that
manifest. This is the one test that crosses all three packages — harness, environments, and
the composed template — and it asserts the written recording validates on read-back.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from game_sandbox_harness.cli import main
from game_sandbox_harness.recording.local import FolderRecordingStore

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from compose import compose_example  # noqa: E402


def test_cli_plays_composed_hello_and_records(tmp_path: Path):
    repo = compose_example("flappy_bird", "hello")  # full runnable repo under build/examples/

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


@pytest.mark.parametrize(
    "source,recorded,expected_actions",
    [
        ("noop", True, [0, 0, 0]),
        ("scripted", True, [1, 0, 1]),
        ("noop", False, None),
        ("scripted", False, None),
    ],
)
def test_cli_public_main_plays_flappy_bird_sources(
    source, recorded, expected_actions, tmp_path, monkeypatch, capsys
):
    monkeypatch.chdir(tmp_path)
    if source == "scripted":
        path = tmp_path / "actions.json"
        path.write_text("[1, 0, 1]", encoding="utf-8")
        source = f"scripted:{path}"
    argv = ["--env", "flappy_bird", "--source", source, "--seed", "19", "--steps", "3"]
    record_root = tmp_path / "recordings"
    if recorded:
        argv.extend(["--record", str(record_root)])
    assert main(argv) == 0
    summary = {
        key.strip(): value.strip()
        for key, value in (line.split(":", 1) for line in capsys.readouterr().out.splitlines())
    }
    assert {key: summary[key] for key in ("environment", "seed", "ticks", "reason")} == {
        "environment": "flappy_bird",
        "seed": "19",
        "ticks": "3",
        "reason": "truncated",
    }
    if recorded:
        store = FolderRecordingStore(record_root)
        assert store.list_ids() == [summary["recording_id"]]
        recording = store.open(summary["recording_id"])
        assert (recording.header["environment"], recording.header["seed"]) == ("flappy_bird", 19)
        steps = list(recording.steps())
        assert [step["tick"] for step in steps] == [0, 1, 2]
        assert [step["agents"]["player_0"]["action"] for step in steps] == expected_actions
    else:
        assert "recording_id" not in summary
        assert not list(tmp_path.rglob("recording.jsonl"))


@pytest.mark.parametrize(
    "payload,error,cause",
    [
        (None, ValueError, "unrecognised --source 'unknown'"),
        ("{not json", json.JSONDecodeError, None),
        ('{"action":1}', ValueError, "JSON list of actions"),
    ],
)
def test_cli_public_main_rejects_invalid_sources(payload, error, cause, tmp_path):
    source = "unknown"
    if payload is not None:
        path = tmp_path / "actions.json"
        path.write_text(payload, encoding="utf-8")
        source = f"scripted:{path}"
    with pytest.raises(error, match=cause) as caught:
        main(["--env", "flappy_bird", "--source", source, "--steps", "3"])
    if isinstance(caught.value, json.JSONDecodeError):
        assert caught.value.doc == payload
