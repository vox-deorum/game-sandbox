"""Keep the checked-in Crane Reach recordings and legality masks reproducible."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gen_crane_fixture  # noqa: E402
from _fixture_common import FIXTURES_DIR  # noqa: E402

FIXTURE_NAMES = (
    "crane-reach-skirmish-recording.jsonl",
    "crane-reach-skirmish-legality.json",
    "crane-reach-army-recording.jsonl",
    "crane-reach-army-legality.json",
)


def test_crane_fixtures_are_fresh(tmp_path: Path) -> None:
    gen_crane_fixture.generate(tmp_path)

    for name in FIXTURE_NAMES:
        assert (tmp_path / name).read_bytes() == (FIXTURES_DIR / name).read_bytes(), (
            f"{name} is stale; run `uv run python scripts/gen_crane_fixture.py`"
        )
