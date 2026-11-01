"""Folder store: round trip, truncated-prefix tolerance, version mismatch, unknown sidecar."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from game_sandbox_harness.recording import RecordingError
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.schema import SchemaValidationError


def _header(**kwargs: object):
    return {
        "schema_version": 1,
        "environment": "flappy",
        "parameters": {"players": 1, "pipe_gap": 100},
        "players": {"player_0": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}},
        "seats": {"seat_0": ["player_0"]},
        "seat_plan": "solo",
        **kwargs,
    }


def _step(tick: int):
    return {
        "schema_version": 1,
        "tick": tick,
        "agents": {"player_0": {"reward": float(tick), "score": float(tick)}},
        "timing": {"started_at": 1_700_000_000_000 + tick, "duration_ms": 1.0},
    }


def test_write_then_read_round_trip(tmp_path: Path):
    mirrored = []
    path = tmp_path / "run1" / "recording.jsonl"

    def on_line(line):
        mirrored.append(line)
        assert path.read_bytes() == "".join(mirrored).encode("utf-8")

    store = FolderRecordingStore(tmp_path, on_line=on_line)
    with store.create("run1", _header(seed=1)) as writer:
        for tick in (0, 1):
            writer.write_step(_step(tick))

    recording = store.open("run1")
    assert recording.header == _header(seed=1)
    assert list(recording.steps()) == [_step(0), _step(1)]
    assert [json.loads(line) for line in mirrored] == [_header(seed=1), _step(0), _step(1)]
    assert store.list_ids() == ["run1"]


def test_write_step_rejects_a_malformed_live_state_even_when_the_recorded_state_is_valid(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    with store.create("run1", _header()) as writer:
        malformed_live_state = dict(_step(0))
        del malformed_live_state["tick"]
        with pytest.raises(SchemaValidationError):
            writer.write_step(_step(0), live_state=malformed_live_state)  # type: ignore[arg-type]

    lines = (tmp_path / "run1" / "recording.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1  # only the header: the invalid live_state never reached disk


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits only")
def test_created_recording_permissions_allow_host_cleanup(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    with store.create("run1", _header()):
        pass

    assert ((tmp_path / "run1").stat().st_mode & 0o007) == 0o007
    assert ((tmp_path / "run1" / "recording.jsonl").stat().st_mode & 0o004) == 0o004


@pytest.mark.parametrize(
    ("separator", "tail"),
    [("\n", ""), ("\n\n\n", ""), ("\n", '{"schema_version":1,"tick":2,"agen'), ("\n\n", "{unfinished")],
)
def test_truncated_file_yields_readable_prefix(tmp_path: Path, separator: str, tail: str):
    store = FolderRecordingStore(tmp_path)
    jsonl = tmp_path / "run1" / "recording.jsonl"
    jsonl.parent.mkdir()
    jsonl.write_text(
        separator.join(json.dumps(value) for value in (_header(), _step(0), _step(1))) + separator + tail,
        encoding="utf-8",
    )

    steps = list(store.open("run1").steps())
    assert [s["tick"] for s in steps] == [0, 1]


@pytest.mark.parametrize("target", ["header", "state"])
def test_header_version_mismatch_rejected(tmp_path: Path, target: str):
    store = FolderRecordingStore(tmp_path)
    header, state = _header(), _step(0)
    with store.create("run1", header) as writer:
        writer.write_step(state)
    assert list(store.open("run1").steps()) == [_step(0)]

    payload = header if target == "header" else state
    payload["schema_version"] = 2
    (tmp_path / "run1" / "recording.jsonl").write_text(
        json.dumps(header) + "\n" + json.dumps(state) + "\n",
        encoding="utf-8",
    )
    if target == "state":
        assert store.open("run1").header == _header()
    with pytest.raises((RecordingError, SchemaValidationError), match="schema_version"):
        list(store.open("run1").steps())


def test_unknown_sidecar_loads_cleanly(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    header = _header(
        sidecars=[{"name": "mystery-future-sidecar", "path": "mystery.bin"}],
    )
    with store.create("run1", header) as writer:
        writer.write_step(_step(0))

    recording = store.open("run1")
    # The unknown sidecar is preserved in the header and ignored; the recording loads.
    assert recording.header["sidecars"][0]["name"] == "mystery-future-sidecar"
    assert [s["tick"] for s in recording.steps()] == [0]


def test_reader_rejects_a_header_with_duplicate_seat_members(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    jsonl_dir = tmp_path / "run1"
    jsonl_dir.mkdir()
    header = _header()
    header["seats"] = {"seat_0": ["player_0"], "seat_1": ["player_0"]}
    (jsonl_dir / "recording.jsonl").write_text(f"{json.dumps(header)}\n", encoding="utf-8")
    with pytest.raises(SchemaValidationError, match="multiple seats"):
        store.open("run1")


def test_open_missing_recording_raises(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    with pytest.raises(RecordingError):
        store.open("does-not-exist")
