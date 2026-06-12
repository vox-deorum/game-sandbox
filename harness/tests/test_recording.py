"""Folder store: round trip, truncated-prefix tolerance, version mismatch, unknown sidecar."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from game_sandbox_harness.recording import RecordingError
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.schema import SchemaValidationError
from game_sandbox_harness.state import build_agent_step, build_header, build_step_state


def _step(tick: int):
    return build_step_state(
        tick=tick,
        agents={"player_0": build_agent_step(reward=float(tick), score=float(tick))},
        started_at=1_700_000_000_000 + tick,
        duration_ms=1.0,
    )


def test_write_then_read_round_trip(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    header = build_header(environment="flappy", seed=1)
    with store.create("run1", header) as writer:
        writer.write_step(_step(0))
        writer.write_step(_step(1))

    recording = store.open("run1")
    assert recording.header["environment"] == "flappy"
    steps = list(recording.steps())
    assert [s["tick"] for s in steps] == [0, 1]
    assert store.list_ids() == ["run1"]


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits only")
def test_created_recording_permissions_allow_host_cleanup(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    with store.create("run1", build_header(environment="flappy")):
        pass

    assert ((tmp_path / "run1").stat().st_mode & 0o777) == 0o777
    assert ((tmp_path / "run1" / "recording.jsonl").stat().st_mode & 0o777) == 0o666


def test_truncated_file_yields_readable_prefix(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    with store.create("run1", build_header(environment="flappy")) as writer:
        writer.write_step(_step(0))
        writer.write_step(_step(1))

    # Simulate a crash mid-write by appending a half-written final line.
    jsonl = tmp_path / "run1" / "recording.jsonl"
    with jsonl.open("a", encoding="utf-8") as handle:
        handle.write('{"schema_version":1,"tick":2,"agen')

    steps = list(store.open("run1").steps())
    assert [s["tick"] for s in steps] == [0, 1]


def test_header_version_mismatch_rejected(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    jsonl_dir = tmp_path / "run1"
    jsonl_dir.mkdir()
    (jsonl_dir / "recording.jsonl").write_text(
        '{"schema_version":2,"environment":"flappy"}\n', encoding="utf-8"
    )
    # A version-1 reader refuses a version-2 recording. The schema's const:1 catches it
    # as a validation error; the explicit RecordingError equality check is the same
    # refusal generalized for when the schema later moves to v1/, v2/ directories.
    with pytest.raises((RecordingError, SchemaValidationError)):
        store.open("run1")


def test_state_line_version_mismatch_rejected(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    jsonl_dir = tmp_path / "run1"
    jsonl_dir.mkdir()
    # Valid header, but a state line carrying a different version (schema const makes it
    # invalid first; this asserts the loader refuses to yield it).
    (jsonl_dir / "recording.jsonl").write_text(
        '{"schema_version":1,"environment":"flappy"}\n'
        '{"schema_version":2,"tick":0,"agents":{},'
        '"timing":{"started_at":0,"duration_ms":0}}\n',
        encoding="utf-8",
    )
    with pytest.raises((RecordingError, SchemaValidationError)):
        list(store.open("run1").steps())


def test_unknown_sidecar_loads_cleanly(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    header = build_header(
        environment="flappy",
        sidecars=[{"name": "mystery-future-sidecar", "path": "mystery.bin"}],
    )
    with store.create("run1", header) as writer:
        writer.write_step(_step(0))

    recording = store.open("run1")
    # The unknown sidecar is preserved in the header and ignored; the recording loads.
    assert recording.header["sidecars"][0]["name"] == "mystery-future-sidecar"
    assert [s["tick"] for s in recording.steps()] == [0]


def test_open_missing_recording_raises(tmp_path: Path):
    store = FolderRecordingStore(tmp_path)
    with pytest.raises(RecordingError):
        store.open("does-not-exist")
