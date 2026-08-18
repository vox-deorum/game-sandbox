"""Season presets: the teaching arcs that opt into day/night via the preset value defaults."""

from __future__ import annotations

from game_sandbox_harness.environment import resolve_parameters
from three_branches import META


def test_season_presets_resolve_defaults_for_every_teaching_arc_season() -> None:
    # The teaching arcs that opt into day/night declare it via the preset values' defaults.
    for preset in META.presets:
        resolved = resolve_parameters(META, preset.values)
        assert resolved["daynight"] is (preset.name in {"season_4", "season_5", "season_6"})
