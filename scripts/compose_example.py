"""Compose a runnable example from the template plus an example overlay.

``uv run python scripts/compose_example.py <name>`` copies ``templates/**`` into the
gitignored ``build/examples/<name>/``, then copies ``examples/<name>/**`` on top with
whole-file replacement, so an overlay file always wins. There is no manifest: the
convention plus one merge rule is the whole mechanism.

The one merge rule: lines from the overlay's ``requirements.extra.txt`` are appended to
the composed ``requirements.txt``. Extras extend the dependency set; they never override
it, so if a package is pinned in both, compose fails loudly. This is the same code path
CI and the publish workflow use, so a student's clone is byte-identical to what CI tested.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from _paths import BUILD_DIR, EXAMPLES_DIR, TEMPLATES_DIR

_EXTRA_REQUIREMENTS = "requirements.extra.txt"
_REQUIREMENTS = "requirements.txt"


class ComposeError(Exception):
    """Raised when an example cannot be composed (for example a conflicting dependency pin)."""


def _requirement_name(line: str) -> str | None:
    """Return the normalized package name for a requirements line, or None for non-pins.

    Only enough parsing for the conflict check: comments and blanks are ignored, and the
    name is the text before the first version or extras specifier.
    """
    text = line.split("#", 1)[0].strip()
    if not text:
        return None
    for separator in ("==", ">=", "<=", "~=", "!=", ">", "<", "[", " ", ";"):
        index = text.find(separator)
        if index != -1:
            text = text[:index]
    return text.strip().lower().replace("_", "-") or None


def _merge_requirements(base_text: str, extra_text: str) -> str:
    """Append extra requirement lines to base, failing loudly on a conflicting pin."""
    base_names = {
        name for line in base_text.splitlines() if (name := _requirement_name(line)) is not None
    }
    extra_lines: list[str] = []
    for line in extra_text.splitlines():
        name = _requirement_name(line)
        if name is not None and name in base_names:
            raise ComposeError(
                f"dependency {name!r} is pinned in both the template's requirements.txt and the "
                f"example's {_EXTRA_REQUIREMENTS}. Extras may only extend the dependency set, "
                f"never override a template pin; ask for a new template release instead."
            )
        if name is not None:
            base_names.add(name)
        extra_lines.append(line)

    merged = base_text.rstrip("\n") + "\n"
    if extra_lines:
        merged += "\n# --- appended from the example's requirements.extra.txt ---\n"
        merged += "\n".join(extra_lines).rstrip("\n") + "\n"
    return merged


def compose(name: str) -> Path:
    """Compose example ``name`` into ``build/examples/<name>/`` and return that path."""
    example_dir = EXAMPLES_DIR / name
    if not example_dir.is_dir():
        raise ComposeError(f"no example named {name!r} under {EXAMPLES_DIR}")
    if not TEMPLATES_DIR.is_dir():
        raise ComposeError(f"no template content under {TEMPLATES_DIR}")

    out_dir = BUILD_DIR / "examples" / name
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    # 1. The template is the base.
    shutil.copytree(TEMPLATES_DIR, out_dir, dirs_exist_ok=True)

    # 2. Overlay every example file except the extras file, with whole-file replacement.
    for src in sorted(p for p in example_dir.rglob("*") if p.is_file()):
        relative = src.relative_to(example_dir)
        if relative.name == _EXTRA_REQUIREMENTS:
            continue
        dest = out_dir / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)

    # 3. Apply the one merge rule for requirements.extra.txt.
    extra_path = example_dir / _EXTRA_REQUIREMENTS
    if extra_path.exists():
        base_req = out_dir / _REQUIREMENTS
        base_text = base_req.read_text(encoding="utf-8") if base_req.exists() else ""
        base_req.write_text(
            _merge_requirements(base_text, extra_path.read_text(encoding="utf-8")),
            encoding="utf-8",
            newline="\n",
        )

    return out_dir


def list_examples() -> list[str]:
    if not EXAMPLES_DIR.is_dir():
        return []
    return sorted(p.name for p in EXAMPLES_DIR.iterdir() if p.is_dir())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compose an example from the template.")
    parser.add_argument("name", nargs="?", help="example name; omit to list available examples")
    args = parser.parse_args(argv)

    if args.name is None:
        for name in list_examples():
            print(name)
        return 0

    try:
        out_dir = compose(args.name)
    except ComposeError as error:
        print(f"compose failed: {error}", file=sys.stderr)
        return 1
    print(f"composed {args.name} -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
