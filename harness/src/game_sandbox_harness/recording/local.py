"""A recording store backed by a folder on disk.

Layout is one directory per recording, ``<root>/<id>/recording.jsonl``, with sidecars
at their header-declared relative paths inside that directory. The per-recording
directory is the S3 seam: it maps one to one onto an object-key prefix.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from pathlib import Path
from types import TracebackType
from typing import IO, TYPE_CHECKING

from ..state import RecordingHeader, StepState
from . import (
    RecordingError,
    check_header,
    check_step,
)

_RECORDING_FILENAME = "recording.jsonl"


def _dump_line(payload: object) -> str:
    # Compact, stable, one line. sort_keys keeps fixtures deterministic across runs.
    return json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\n"


class _FolderRecordingWriter:
    """Writes a header line then one validated state per line, flushing on every write.

    When ``on_line`` is given, each serialized line (header and every state) is also handed to
    it — serialized exactly once, so a mirror destination (Stage 3's live protocol stream)
    cannot drift from the bytes on disk. The callback runs after the file write and flush, so a
    streaming consumer never sees a line the recording has not yet durably captured.
    """

    def __init__(
        self,
        path: Path,
        header: RecordingHeader,
        on_line: Callable[[str], None] | None = None,
    ) -> None:
        check_header(header)
        self._header = header
        self._on_line = on_line
        self._handle: IO[str] = path.open("w", encoding="utf-8", newline="\n")
        path.chmod(0o666)
        self._emit(_dump_line(header))

    def write_step(self, state: StepState) -> None:
        check_step(state, self._header["schema_version"])
        self._emit(_dump_line(state))

    def _emit(self, line: str) -> None:
        self._handle.write(line)
        self._handle.flush()
        if self._on_line is not None:
            self._on_line(line)

    def __enter__(self) -> _FolderRecordingWriter:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self._handle.close()


class _FolderRecording:
    """An opened recording: validated header, lazy iterator of validated states."""

    def __init__(self, path: Path) -> None:
        self._path = path
        with path.open("r", encoding="utf-8") as handle:
            first = handle.readline()
        if not first.strip():
            raise RecordingError(f"recording {path} is empty")
        header: RecordingHeader = json.loads(first)
        check_header(header)
        self._header = header

    @property
    def header(self) -> RecordingHeader:
        return self._header

    def steps(self) -> Iterator[StepState]:
        version = self._header["schema_version"]
        with self._path.open("r", encoding="utf-8") as handle:
            handle.readline()  # skip the header line
            for raw in handle:
                # A crashed session can leave a half-written final line; a blank or
                # truncated trailing line is simply where the readable prefix ends.
                line = raw.strip()
                if not line:
                    continue
                try:
                    state: StepState = json.loads(line)
                except json.JSONDecodeError:
                    break
                check_step(state, version)
                yield state


class FolderRecordingStore:
    """A :class:`RecordingStore` over a root directory on disk.

    ``on_line``, when supplied, mirrors every serialized header and state line emitted by the
    writers this store creates. It is the seam Stage 3's tee uses to stream the same bytes it
    persists; left ``None`` (the default), the store behaves exactly as a plain on-disk store.
    """

    def __init__(self, root: Path | str, *, on_line: Callable[[str], None] | None = None) -> None:
        self._root = Path(root)
        self._on_line = on_line
        self._root.mkdir(parents=True, exist_ok=True)

    def _dir(self, recording_id: str) -> Path:
        return self._root / recording_id

    def create(self, recording_id: str, header: RecordingHeader) -> _FolderRecordingWriter:
        directory = self._dir(recording_id)
        directory.mkdir(parents=True, exist_ok=True)
        # Live sessions write through a root-owned, cap-dropped container onto a host bind mount.
        # Make each recording directory removable by the backend user after the container exits.
        directory.chmod(0o777)
        return _FolderRecordingWriter(directory / _RECORDING_FILENAME, header, self._on_line)

    def open(self, recording_id: str) -> _FolderRecording:
        path = self._dir(recording_id) / _RECORDING_FILENAME
        if not path.exists():
            raise RecordingError(f"no recording with id {recording_id!r} under {self._root}")
        return _FolderRecording(path)

    def list_ids(self) -> list[str]:
        if not self._root.exists():
            return []
        return sorted(
            child.name
            for child in self._root.iterdir()
            if child.is_dir() and (child / _RECORDING_FILENAME).exists()
        )


# Structural conformance check: these classes must satisfy their protocols. Evaluated by
# pyright under TYPE_CHECKING only (this block never runs), so there is no side effect.
if TYPE_CHECKING:
    from . import Recording, RecordingStore, RecordingWriter

    _concrete = FolderRecordingStore(".")
    _store: RecordingStore = _concrete
    _writer: RecordingWriter = _concrete.create(
        "id", {"schema_version": 1, "environment": "x", "parameters": {"players": 1}}
    )
    _recording: Recording = _concrete.open("id")
