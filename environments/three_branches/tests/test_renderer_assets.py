import re
import struct
from pathlib import Path

RENDERER = Path(__file__).parents[1] / "renderer"
ASSETS = RENDERER / "assets"
SOURCE_ART = RENDERER / "source-art"
ASSET_ENTRY = re.compile(
    r"name:\s*'(?P<name>[^']+)',\s*"
    r"source:\s*'\./source-art/(?P<source>[^']+)',\s*"
    r"path:\s*'\./assets/(?P<file>[^']+)',\s*"
    r"width:\s*(?P<width>\d+),\s*height:\s*(?P<height>\d+),\s*"
    r"tintable:\s*(?P<tintable>true|false),"
)


def manifest_assets() -> dict[str, tuple[str, int, int, bool]]:
    entries = list(ASSET_ENTRY.finditer((RENDERER / "assets.ts").read_text(encoding="utf-8")))
    assert len(entries) == 65
    assert len({entry.group("name") for entry in entries}) == len(entries)
    assert len({entry.group("source") for entry in entries}) == len(entries)
    return {
        entry.group("file"): (
            entry.group("source"),
            int(entry.group("width")),
            int(entry.group("height")),
            entry.group("tintable") == "true",
        )
        for entry in entries
    }


def test_renderer_asset_manifest_files_have_the_declared_formats_and_sizes() -> None:
    declared = manifest_assets()
    assert {path.name for path in ASSETS.iterdir() if path.is_file()} == set(declared)

    for name, (_, width, height, tintable) in declared.items():
        data = (ASSETS / name).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n"
        assert struct.unpack(">II", data[16:24]) == (width, height)
        expected_color_type = 4 if tintable else (2 if name == "paper-field.png" else 6)
        assert data[25] == expected_color_type


def test_renderer_asset_manifest_preserves_source_art() -> None:
    declared_sources = {source for source, _, _, _ in manifest_assets().values()}
    actual_sources = {path.name for path in SOURCE_ART.iterdir() if path.is_file()}
    assert actual_sources == declared_sources | {"thumbnail-source.png"}


def test_character_assets_match_the_declared_layer_contract() -> None:
    declared = manifest_assets()
    for name in (
        "villager-head-a.png",
        "villager-head-b.png",
        "villager-head-c.png",
        "visitor-head.png",
    ):
        assert declared[name][1:3] == (192, 192)
    assert declared["character-hands.png"][1:3] == (4 * 192, 192)


def test_generated_thumbnail_is_a_320_by_180_rgb_png() -> None:
    data = (RENDERER / "thumbnail.png").read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", data[16:24]) == (320, 180)
    assert data[25] == 2
