"""MkDocs hook exposing canonical environment guides as virtual student pages."""

from __future__ import annotations

from collections.abc import MutableMapping, MutableSequence
from typing import Any

from mkdocs.structure.files import File, Files

from _environment_guides import (
    EnvironmentGuideError,
    discover_environment_guides,
    environment_guide_virtual_path,
    render_environment_guide,
    validate_environment_guide_catalog,
)


def _inject_environment_nav(nav: MutableSequence[Any], paths: list[str]) -> None:
    """Place discovered pages after the hand-authored environment catalog."""
    catalog = "students/environments/index.md"

    def inject(items: MutableSequence[Any]) -> bool:
        for index, item in enumerate(items):
            if item == catalog:
                items[index + 1 : index + 1] = paths
                return True
            if isinstance(item, MutableMapping):
                for children in item.values():
                    if isinstance(children, MutableSequence) and inject(children):
                        return True
        return False

    if not inject(nav):
        raise EnvironmentGuideError(f"MkDocs navigation has no environment catalog entry for {catalog}")


def on_files(files: Files, *, config) -> Files:
    """Pre-render and add every dynamic guide without creating a source mirror."""
    env_ids = discover_environment_guides()
    validate_environment_guide_catalog(env_ids)
    rendered = {
        environment_guide_virtual_path(env_id).as_posix(): render_environment_guide(env_id, "docs_site")
        for env_id in env_ids
    }

    existing_paths = {file.src_uri for file in files}
    collisions = sorted(existing_paths.intersection(rendered))
    if collisions:
        raise EnvironmentGuideError(
            f"canonical environment guides collide with docs source pages: {collisions}"
        )
    if config.nav is None:
        raise EnvironmentGuideError("MkDocs navigation must be explicit")
    _inject_environment_nav(config.nav, list(rendered))
    for path, content in rendered.items():
        files.append(File.generated(config, path, content=content))
    return files
