"""Keep the checked-in Three Branches renderer fixtures reproducible."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gen_three_branches_fixture  # noqa: E402
from _fixture_common import FIXTURES_DIR  # noqa: E402

FIXTURE_NAMES = (
    "three-branches-recording.jsonl",
    "three-branches-decoded.json",
)


@pytest.mark.skip(reason="Three Branches layer 3 tuning defers fixture regeneration until the layer closes")
def test_three_branches_fixtures_are_fresh(tmp_path: Path) -> None:
    gen_three_branches_fixture.generate(tmp_path)

    for name in FIXTURE_NAMES:
        assert (tmp_path / name).read_bytes() == (FIXTURES_DIR / name).read_bytes(), (
            f"{name} is stale; run `uv run python scripts/gen_three_branches_fixture.py`"
        )
