"""MkDocs hook: render the specification under specs/ as its own site section.

The files under specs/ are the only editable source and are not duplicated into docs/.
This hook injects every specs/*.md into the build as a top-level ``specs/`` section, so
``mkdocs build`` and ``mkdocs serve`` stay self-contained with no copy step to forget.
Because the spec files cross-link each other with plain relative links and land as
siblings here, those links resolve unchanged and the strict build verifies them.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mkdocs.structure.files import File, Files


def on_files(files: Files, config: Any) -> Files:
    repo_root = Path(config["config_file_path"]).parent
    specs_dir = repo_root / "specs"
    if not specs_dir.is_dir():
        return files

    for md in sorted(specs_dir.glob("*.md")):
        # MkDocs treats specs/README.md as the section's index page automatically.
        files.append(
            File(
                path=f"specs/{md.name}",
                src_dir=str(repo_root),
                dest_dir=config["site_dir"],
                use_directory_urls=config["use_directory_urls"],
            )
        )
    return files
