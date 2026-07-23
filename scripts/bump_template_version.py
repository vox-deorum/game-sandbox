"""Bump the repo to a new template/dependency-set version, or check the touchpoints agree.

The version ``N`` is one number wearing several hats (see ``backend/src/deps-version.ts``): the
``template-v<N>`` release tag, the ``deps-v<N>`` session-image tag, and the ``template_version`` an
agent manifest targets. Releasing a new version therefore means editing several files in lockstep,
which used to be undocumented manual work the ``template-publish`` workflow trusted the operator to
have done. This script *is* that work, so a release dispatch can perform the bump itself and nothing
drifts.

Two modes:

- ``--version N`` (apply): move the whole repo to exactly ``N``. ``N`` greater than the current
  version performs the bump; ``N`` equal to it is a validated no-op (the retry / already-bumped
  path a release re-run takes, or the republish path for an already-tagged current version); ``N``
  less than it is refused, because publishing an older label would mislabel the release.
- ``--check``: touch nothing; exit non-zero unless every version touchpoint already agrees. CI runs
  this on every pull request (wired into ``scripts/ci.py``'s generated-code-fresh job), so a manual
  edit that desyncs the manifest, the backend constant, and the frozen image is caught before it
  can reach a release.

What a bump touches, all to the same ``N``:

1. ``templates/base/manifest.json`` ``template_version`` — the canonical value every composed
   template and example inherits.
2. Each ``frontend/e2e/fixtures/submission/*/manifest.json`` — these are submitted against seasons
   the backend seeds at the current ``DEPS_VERSION``, so a stale value would fail the e2e suite.
3. ``backend/src/deps-version.ts`` — the ``DEPS_VERSION`` constant and a new ``SESSION_BASE_IMAGES``
   registry entry pointing at the new image directory (old entries are never removed; a released
   version stays buildable forever).
4. ``backend/images/session-base/deps-v<N>/`` — a fresh frozen snapshot: ``requirements.txt`` frozen
   from the *current* ``templates/base/requirements.txt``, the previous version's ``Dockerfile`` with
   its ``deps-v<prev>`` paths and version prose rewritten, and its ``builtin/`` agents copied with
   their manifests bumped. **Escape hatch:** if ``deps-v<N>/`` already exists in the checkout (a
   maintainer hand-crafted it in a PR because the image recipe itself changed), it is left untouched
   and only validated, so the deliberate snapshot always wins over the mechanical copy.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

from _paths import (
    DEPS_VERSION_TS,
    E2E_SUBMISSION_FIXTURES_DIR,
    SESSION_BASE_IMAGES_DIR,
    TEMPLATE_BASE_MANIFEST,
    TEMPLATE_BASE_REQUIREMENTS,
)

# A requirements pin: a package name (with optional extras) fixed with ``==``. The freeze rejects any
# survivor that is not one of these (an ``-e`` editable, a ``-r`` include, an unpinned name), so a
# non-locked template requirements file fails loudly rather than shipping a wobbly frozen image.
_PIN_RE = re.compile(r"^[A-Za-z0-9._-]+(?:\[[A-Za-z0-9,._-]+\])?==\S+$")

# The two anchors in deps-version.ts the bump edits. Each must match exactly once; a miss means the
# file was refactored out from under the script, which must fail rather than silently no-op.
_DEPS_VERSION_RE = re.compile(r"^export const DEPS_VERSION = (\d+)$", re.MULTILINE)
_SESSION_MAP_RE = re.compile(
    r"(const SESSION_BASE_IMAGES[^\n]*= new Map\(\[\n)(.*?)(\]\))",
    re.DOTALL,
)


class BumpError(Exception):
    """Raised when a bump or check cannot proceed (bad version, missing anchor, drifted state)."""


def _relative_dockerfile(version: int) -> str:
    """The build-context-relative Dockerfile path as it appears in the registry and the Dockerfile."""
    return f"backend/images/session-base/deps-v{version}/Dockerfile"


def current_version() -> int:
    """The repo's current template version, read from the canonical base manifest."""
    return _read_manifest_version(TEMPLATE_BASE_MANIFEST)


def _read_manifest_version(path: Path) -> int:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise BumpError(f"{path} does not exist") from error
    except json.JSONDecodeError as error:
        raise BumpError(f"{path} is not valid JSON: {error}") from error
    version = data.get("template_version")
    if not isinstance(version, int) or isinstance(version, bool):
        raise BumpError(f"{path} 'template_version' must be an integer, got {version!r}")
    return version


def set_manifest_version(path: Path, version: int) -> None:
    """Rewrite ``template_version`` in a manifest, preserving key order and 2-space formatting."""
    data = json.loads(path.read_text(encoding="utf-8"))
    data["template_version"] = version
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _frozen_header_marker(version: int) -> str:
    """The stable first-line marker a versioned requirements file carries."""
    return f"# Dependency set for the deps-v{version}"


def _frozen_header(version: int) -> str:
    return (
        f"{_frozen_header_marker(version)} session base image. This snapshot may be regenerated with "
        f"the matching\n# template until template-v{version} is published. After publication it is "
        f"immutable, and changes require v{version + 1}.\n"
    )


def freeze_requirements(src_text: str, version: int) -> str:
    """Freeze a pip-compile requirements file into a bare pinned set with the frozen-vN header.

    Drops blank lines and every comment (pip-compile's indented ``# via`` provenance blocks and any
    header), keeping only the pins in their existing order, and refuses anything that is not a
    ``name==version`` pin so an editable/unpinned entry cannot slip into a frozen image.
    """
    pins: list[str] = []
    for line in src_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not _PIN_RE.match(stripped):
            raise BumpError(
                f"{TEMPLATE_BASE_REQUIREMENTS} line {stripped!r} is not a '==' pin; a frozen "
                "dependency set must be fully locked (run pip-compile, no editable or unpinned entries)."
            )
        pins.append(stripped)
    if not pins:
        raise BumpError(f"{TEMPLATE_BASE_REQUIREMENTS} has no pins to freeze.")
    return _frozen_header(version) + "\n".join(pins) + "\n"


def bump_deps_version_ts(text: str, prev: int, new: int) -> str:
    """Set ``DEPS_VERSION`` to ``new`` and append the ``new`` registry entry, failing on any surprise."""
    matches = _DEPS_VERSION_RE.findall(text)
    if len(matches) != 1:
        raise BumpError(
            f"expected exactly one 'export const DEPS_VERSION = <n>' in {DEPS_VERSION_TS}, "
            f"found {len(matches)}."
        )
    if int(matches[0]) != prev:
        raise BumpError(
            f"{DEPS_VERSION_TS} has DEPS_VERSION = {matches[0]}, expected {prev} before bumping to {new}."
        )
    text = _DEPS_VERSION_RE.sub(f"export const DEPS_VERSION = {new}", text, count=1)

    map_match = _SESSION_MAP_RE.search(text)
    if map_match is None:
        raise BumpError(f"could not find the SESSION_BASE_IMAGES map in {DEPS_VERSION_TS}.")
    entries = map_match.group(2)
    new_entry = f"  [{new}, {{ dockerfile: '{_relative_dockerfile(new)}' }}],\n"
    if f"[{new}," in entries:
        raise BumpError(f"{DEPS_VERSION_TS} already registers version {new}.")
    if f"[{prev}," not in entries:
        raise BumpError(
            f"{DEPS_VERSION_TS} does not register the current version {prev}; refusing to append {new}."
        )
    replacement = map_match.group(1) + entries + new_entry + map_match.group(3)
    return text[: map_match.start()] + replacement + text[map_match.end() :]


def rewrite_dockerfile(text: str, prev: int, new: int) -> str:
    """Copy a versioned Dockerfile forward: rewrite its deps-v<prev> paths and version prose.

    The ``deps-v<prev>`` COPY paths are rewritten everywhere (a Dockerfile that no longer names its own
    version directory is a bug, so zero replacements fails). Loose version prose (``v<prev>``,
    ``version <prev>``) is rewritten only on comment lines, so image content like ``python:3.12-slim``
    is never touched.
    """
    prev_marker = f"deps-v{prev}"
    if prev_marker not in text:
        raise BumpError(
            f"the deps-v{prev} Dockerfile does not reference {prev_marker!r}; cannot derive deps-v{new}."
        )
    # deps-v<prev> -> deps-v<new> first, so the prose sweep below cannot mistake the 'v<prev>' inside a
    # 'deps-v<prev>' path for standalone version prose.
    text = text.replace(prev_marker, f"deps-v{new}")

    # The trailing (?!\.\d) guard keeps a dotted version like 'v1.2.x' or 'version 1.2' intact: '.'
    # is a word boundary, so a bare '\bv1\b' would otherwise rewrite the '1' inside 'v1.2'.
    version_word = re.compile(rf"\bversion {prev}\b(?!\.\d)")
    bare_version = re.compile(rf"\bv{prev}\b(?!\.\d)")
    rewritten = []
    for line in text.splitlines(keepends=True):
        if line.lstrip().startswith("#"):
            line = version_word.sub(f"version {new}", line)
            line = bare_version.sub(f"v{new}", line)
        rewritten.append(line)
    return "".join(rewritten)


def _validate_snapshot(deps_dir: Path, version: int) -> list[str]:
    """Return the ways ``deps_dir`` fails to be a consistent deps-v<version> snapshot (empty = ok)."""
    problems: list[str] = []
    dockerfile = deps_dir / "Dockerfile"
    requirements = deps_dir / "requirements.txt"
    builtin = deps_dir / "builtin"

    if not dockerfile.is_file():
        problems.append(f"{dockerfile} is missing")
    else:
        df_text = dockerfile.read_text(encoding="utf-8")
        if f"deps-v{version}/requirements.txt" not in df_text:
            problems.append(f"{dockerfile} does not COPY its own deps-v{version}/requirements.txt")
        if f"deps-v{version}/builtin" not in df_text:
            problems.append(f"{dockerfile} does not COPY its own deps-v{version}/builtin")
        stray = {other for other in re.findall(r"deps-v(\d+)", df_text) if int(other) != version}
        if stray:
            problems.append(
                f"{dockerfile} references other versions deps-v{sorted(stray)} besides its own {version}"
            )

    if not requirements.is_file():
        problems.append(f"{requirements} is missing")
    elif _frozen_header_marker(version) not in requirements.read_text(encoding="utf-8"):
        problems.append(f"{requirements} is not headed '{_frozen_header_marker(version)[2:]}'")

    if not builtin.is_dir():
        problems.append(f"{builtin} is missing")
    else:
        for manifest in sorted(builtin.glob("*/manifest.json")):
            found = _read_manifest_version(manifest)
            if found != version:
                problems.append(f"{manifest} has template_version {found}, expected {version}")
    return problems


def create_deps_snapshot(prev: int, new: int) -> bool:
    """Create ``deps-v<new>/`` from ``deps-v<prev>`` and the current requirements. Escape hatch aware.

    Returns ``True`` if it wrote the snapshot, ``False`` if a hand-crafted one already existed (in which
    case it is only validated). Raises :class:`BumpError` if an existing snapshot is inconsistent.
    """
    new_dir = SESSION_BASE_IMAGES_DIR / f"deps-v{new}"
    if new_dir.exists():
        problems = _validate_snapshot(new_dir, new)
        if problems:
            raise BumpError(
                f"{new_dir} already exists but is not a valid deps-v{new} snapshot:\n  "
                + "\n  ".join(problems)
            )
        return False

    prev_dir = SESSION_BASE_IMAGES_DIR / f"deps-v{prev}"
    if not prev_dir.is_dir():
        raise BumpError(f"cannot derive deps-v{new}: previous snapshot {prev_dir} does not exist.")

    new_dir.mkdir(parents=True)
    frozen = freeze_requirements(TEMPLATE_BASE_REQUIREMENTS.read_text(encoding="utf-8"), new)
    (new_dir / "requirements.txt").write_text(frozen, encoding="utf-8")

    dockerfile = rewrite_dockerfile((prev_dir / "Dockerfile").read_text(encoding="utf-8"), prev, new)
    (new_dir / "Dockerfile").write_text(dockerfile, encoding="utf-8")

    # Copy the built-in agents verbatim (skipping any stray bytecode a local run left behind), then bump
    # each baseline's manifest to the new version so a submitted agent's manifest_version matches it.
    shutil.copytree(
        prev_dir / "builtin",
        new_dir / "builtin",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    for manifest in sorted((new_dir / "builtin").glob("*/manifest.json")):
        set_manifest_version(manifest, new)
    return True


def _fixture_manifests() -> list[Path]:
    return sorted(E2E_SUBMISSION_FIXTURES_DIR.glob("*/manifest.json"))


def _deps_version_ts_value() -> int:
    """Parse DEPS_VERSION out of deps-version.ts for the consistency check."""
    match = _DEPS_VERSION_RE.search(DEPS_VERSION_TS.read_text(encoding="utf-8"))
    if match is None:
        raise BumpError(f"could not find DEPS_VERSION in {DEPS_VERSION_TS}.")
    return int(match.group(1))


def check() -> list[str]:
    """Return every way the version touchpoints disagree (empty list = fully consistent)."""
    problems: list[str] = []
    version = current_version()

    ts_version = _deps_version_ts_value()
    if ts_version != version:
        problems.append(
            f"{DEPS_VERSION_TS} DEPS_VERSION is {ts_version}, but "
            f"{TEMPLATE_BASE_MANIFEST} template_version is {version}"
        )

    ts_text = DEPS_VERSION_TS.read_text(encoding="utf-8")
    if _relative_dockerfile(version) not in ts_text:
        problems.append(
            f"{DEPS_VERSION_TS} has no SESSION_BASE_IMAGES entry for the current version {version}"
        )

    for manifest in _fixture_manifests():
        found = _read_manifest_version(manifest)
        if found != version:
            problems.append(f"{manifest} template_version is {found}, expected the current {version}")

    problems.extend(_validate_snapshot(SESSION_BASE_IMAGES_DIR / f"deps-v{version}", version))
    return problems


def apply(new: int) -> None:
    """Move the whole repo to version ``new`` (or verify it is already there for a no-op ``new``)."""
    prev = current_version()
    if new < prev:
        raise BumpError(
            f"refusing to bump down: current version is {prev}, requested {new}. Publishing an older "
            "label would mislabel the release."
        )
    if new == prev:
        problems = check()
        if problems:
            raise BumpError(
                f"already at version {new} but the touchpoints are inconsistent:\n  " + "\n  ".join(problems)
            )
        print(f"already at template version {new}; no changes.")
        return

    print(f"bumping template version {prev} -> {new}")

    set_manifest_version(TEMPLATE_BASE_MANIFEST, new)
    print(f"  set {TEMPLATE_BASE_MANIFEST} template_version = {new}")

    for manifest in _fixture_manifests():
        set_manifest_version(manifest, new)
        print(f"  set {manifest} template_version = {new}")

    ts_text = DEPS_VERSION_TS.read_text(encoding="utf-8")
    DEPS_VERSION_TS.write_text(bump_deps_version_ts(ts_text, prev, new), encoding="utf-8")
    print(f"  set {DEPS_VERSION_TS} DEPS_VERSION = {new} and registered deps-v{new}")

    if create_deps_snapshot(prev, new):
        print(f"  created {SESSION_BASE_IMAGES_DIR / f'deps-v{new}'} from deps-v{prev}")
    else:
        print(f"  kept the existing hand-crafted deps-v{new} snapshot (validated)")

    problems = check()
    if problems:
        raise BumpError(
            "bump completed but the result is inconsistent (this is a bug in the bump script):\n  "
            + "\n  ".join(problems)
        )
    print(f"bumped to template version {new}.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bump or check the template/dependency-set version.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--version", type=int, help="bump the repo to exactly this integer version")
    group.add_argument(
        "--check",
        action="store_true",
        help="verify every version touchpoint agrees; exit non-zero otherwise",
    )
    args = parser.parse_args(argv)

    try:
        if args.check:
            problems = check()
            if problems:
                print("version touchpoints are inconsistent:", file=sys.stderr)
                for problem in problems:
                    print(f"  {problem}", file=sys.stderr)
                return 1
            print(f"version touchpoints are consistent at v{current_version()}.")
            return 0
        apply(args.version)
    except BumpError as error:
        print(f"bump failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
