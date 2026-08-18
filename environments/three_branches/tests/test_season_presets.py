"""Season presets: the teaching arc's names and the explicit LLM flags."""

from __future__ import annotations

from game_sandbox_harness.environment import resolve_parameters
from three_branches import META


def test_season_presets_pin_titles_values_and_llm_flags() -> None:
    expected = (
        ("season_1", "Season 1: Village routines", False),
        ("season_2", "Season 2: A larger village", False),
        ("season_3", "Season 3: Village relationships", False),
        ("season_4", "Season 4: Day and night", False),
        ("season_5", "Season 5: Village dialogue", True),
        ("season_6", "Season 6: Living village", True),
    )
    assert tuple((preset.name, preset.title, preset.llm) for preset in META.presets) == expected
    for preset in META.presets:
        resolved = resolve_parameters(META, preset.values)
        assert resolved["daynight"] is (preset.name in {"season_4", "season_5", "season_6"})
