import re
import struct
from pathlib import Path

RENDERER = Path(__file__).parents[1] / "renderer"
ASSETS = RENDERER / "assets"
ASSET_ENTRY = re.compile(
    r"name:\s*'(?P<name>[^']+)',\s*"
    r"path:\s*'\./assets/(?P<file>[^']+)',\s*"
    r"width:\s*(?P<width>\d+),\s*height:\s*(?P<height>\d+),"
)


def manifest_assets() -> dict[str, tuple[int, int]]:
    entries = list(ASSET_ENTRY.finditer((RENDERER / "assets.ts").read_text(encoding="utf-8")))
    assert len(entries) == 31
    assert len({entry.group("name") for entry in entries}) == len(entries)
    return {entry.group("file"): (int(entry.group("width")), int(entry.group("height"))) for entry in entries}


def test_renderer_asset_manifest_files_have_the_declared_formats_and_sizes() -> None:
    declared = manifest_assets()
    assert {path.name for path in ASSETS.iterdir() if path.is_file()} == set(declared)
    assert len(declared) == 31
    assert all(name.endswith(".png") for name in declared)

    for name, expected_size in declared.items():
        data = (ASSETS / name).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n"
        assert struct.unpack(">II", data[16:24]) == expected_size
        assert data[25] == 4  # PNG color type 4 is grayscale with alpha.


def test_generated_thumbnail_is_a_320_by_180_png() -> None:
    data = (RENDERER / "thumbnail.png").read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", data[16:24]) == (320, 180)
    assert data[25] == 2  # PNG color type 2 is RGB.
