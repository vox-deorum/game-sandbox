"""MkDocs hook exposing canonical environment guides as virtual student pages."""

from __future__ import annotations

from collections.abc import MutableMapping, MutableSequence
from typing import Any

from mkdocs.structure.files import File, Files

from _environment_guides import (
    ENVIRONMENT_CATALOG_PATH,
    EnvironmentGuideError,
    discover_environment_guides,
    environment_guide_virtual_path,
    render_environment_catalog,
    render_environment_guide,
)


def _inject_environment_nav(nav: MutableSequence[Any], paths: list[str]) -> None:
    """Place discovered pages after the hand-authored environment catalog."""
    catalog = ENVIRONMENT_CATALOG_PATH.as_posix()

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
    """Pre-render the dynamic catalog and guides without creating source mirrors."""
    env_ids = discover_environment_guides()
    catalog_content = render_environment_catalog(env_ids)
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
    catalog_path = ENVIRONMENT_CATALOG_PATH.as_posix()
    catalog_file = next((file for file in files if file.src_uri == catalog_path), None)
    if catalog_file is None:
        raise EnvironmentGuideError(f"MkDocs files have no environment catalog at {catalog_path}")
    generated_catalog = File.generated(config, catalog_path, content=catalog_content)
    generated_guides = [File.generated(config, path, content=content) for path, content in rendered.items()]

    _inject_environment_nav(config.nav, list(rendered))
    files.remove(catalog_file)
    files.append(generated_catalog)
    for generated_guide in generated_guides:
        files.append(generated_guide)
    return files
