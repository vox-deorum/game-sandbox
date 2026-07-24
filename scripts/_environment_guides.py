"""Publish environment-root student guides through MkDocs and composed templates."""

from __future__ import annotations

import posixpath
import re
from collections.abc import Iterable, Mapping
from pathlib import Path, PurePosixPath
from typing import Literal

from _paths import (
    DOCS_DIR,
    ENVIRONMENT_PACKAGES_DIR,
    env_environment_guide,
)

EnvironmentGuideRenderMode = Literal["docs_site", "composed_kit"]
_MARKDOWN_LINK = re.compile(r"(?<!!)\]\(([^()\n]+)\)")
_MARKDOWN_IMAGE = re.compile(r"!\[[^\]\n]*\]\(([^()\n]+)\)")
_REFERENCE_DEFINITION = re.compile(r"(?m)^\s{0,3}\[[^\]\n]+\]:\s*(\S.*)$")
_SAFE_ENV_ID = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+)*\Z")
_RESERVED_SLUGS = frozenset({"agents", "index", "readme"})
_DOCS_URL_TOKEN = "{{DOCS_URL}}"
ENVIRONMENT_CATALOG_PATH = PurePosixPath("students/environments/index.md")
ENVIRONMENT_CATALOG_MARKER = (
    '[environment-guide-catalog]: # "Populated dynamically from canonical environment guides."'
)


class EnvironmentGuideError(RuntimeError):
    """Raised when an environment guide source or published form is unsafe or incomplete."""


def environment_guide_slug(env_id: str) -> str:
    """Return the only permitted docs filename stem for an environment id."""
    if not _SAFE_ENV_ID.fullmatch(env_id):
        raise EnvironmentGuideError(
            f"environment guide id {env_id!r} must use lowercase letters, digits, and single underscores"
        )
    slug = env_id.replace("_", "-")
    if slug in _RESERVED_SLUGS:
        raise EnvironmentGuideError(f"environment guide slug {slug!r} is reserved")
    return slug


def _environment_ids(environments: Mapping[str, object] | Iterable[str]) -> list[str]:
    ids = sorted(environments if not isinstance(environments, Mapping) else environments.keys())
    slugs: dict[str, str] = {}
    for env_id in ids:
        slug = environment_guide_slug(env_id)
        previous = slugs.setdefault(slug, env_id)
        if previous != env_id:
            raise EnvironmentGuideError(
                f"environment guide ids {previous!r} and {env_id!r} both map to docs slug {slug!r}"
            )
    return ids


def discover_environment_guides() -> list[str]:
    """Discover every environment-root guide without relying on a hard-coded catalog."""
    if not ENVIRONMENT_PACKAGES_DIR.is_dir():
        raise EnvironmentGuideError(f"environment package directory is missing: {ENVIRONMENT_PACKAGES_DIR}")
    env_ids = [
        path.name for path in ENVIRONMENT_PACKAGES_DIR.iterdir() if (path / "environment.md").is_file()
    ]
    return _environment_ids(env_ids)


def _is_external_or_fragment(target: str) -> bool:
    return target.startswith(("#", "//", "http://", "https://", "mailto:"))


def _split_local_target(
    target: str, *, source: Path, require_existing: bool = True
) -> tuple[PurePosixPath, str]:
    """Validate a local Markdown target and resolve it below ``docs/``."""
    if any(character.isspace() for character in target) or target.startswith("<") or "\\" in target:
        raise EnvironmentGuideError(
            f"unsupported local link syntax {target!r} in {source}; use a plain relative .md link"
        )
    path_text, separator, fragment = target.partition("#")
    if path_text.startswith("/") or "?" in path_text:
        raise EnvironmentGuideError(
            f"unsupported local link syntax {target!r} in {source}; use a plain relative .md link"
        )
    if not path_text.endswith(".md"):
        raise EnvironmentGuideError(
            f"local link {target!r} in {source} must target a relative documentation .md file"
        )
    candidate = (source.parent / PurePosixPath(path_text)).resolve()
    try:
        relative = candidate.relative_to(DOCS_DIR.resolve())
    except ValueError as error:
        raise EnvironmentGuideError(
            f"local link {target!r} in {source} must resolve inside {DOCS_DIR}"
        ) from error
    if require_existing and not candidate.is_file():
        raise EnvironmentGuideError(f"local documentation link {target!r} in {source} does not exist")
    return PurePosixPath(relative.as_posix()), f"#{fragment}" if separator else ""


def _docs_url_path(relative: PurePosixPath) -> str:
    """Map one docs-relative Markdown page to its published MkDocs directory path."""
    parts = list(relative.parts)
    if parts[-1] == "index.md":
        parts.pop()
    else:
        parts[-1] = parts[-1][: -len(".md")]
    return "/".join(parts)


def environment_guide_virtual_path(env_id: str) -> PurePosixPath:
    """Return one guide's stable docs-relative virtual path."""
    return PurePosixPath(f"students/environments/{environment_guide_slug(env_id)}.md")


def _docs_site_target(relative: PurePosixPath, virtual_page: PurePosixPath) -> str:
    """Return a docs-site-relative link from a virtual guide to a shared docs page."""
    start = virtual_page.parent
    return posixpath.relpath(relative.as_posix(), start.as_posix())


def _rewrite_local_links(
    text: str,
    *,
    source: Path,
    mode: EnvironmentGuideRenderMode,
    virtual_page: PurePosixPath,
) -> str:
    """Rewrite canonical links into central docs for one supported destination."""
    for match in _MARKDOWN_IMAGE.finditer(text):
        target = match.group(1)
        if not _is_external_or_fragment(target):
            raise EnvironmentGuideError(
                f"local image {target!r} in {source} is unsupported; use an externally hosted image"
            )
    for match in _REFERENCE_DEFINITION.finditer(text):
        target = match.group(1).split(maxsplit=1)[0].strip("<>")
        if not _is_external_or_fragment(target):
            raise EnvironmentGuideError(
                f"local reference-style link {target!r} in {source} is unsupported; "
                "use an inline relative .md link"
            )

    def rewrite(match: re.Match[str]) -> str:
        target = match.group(1)
        if _is_external_or_fragment(target):
            return match.group(0)
        relative, fragment = _split_local_target(target, source=source)
        if mode == "docs_site":
            target = _docs_site_target(relative, virtual_page)
        else:
            target = f"{_DOCS_URL_TOKEN}{_docs_url_path(relative)}/"
        return f"]({target}{fragment})"

    return _MARKDOWN_LINK.sub(rewrite, text)


def render_environment_guide(env_id: str, mode: EnvironmentGuideRenderMode) -> str:
    """Render one canonical guide for the docs site or a standalone composed kit."""
    environment_guide_slug(env_id)
    source = env_environment_guide(env_id)
    if not source.is_file():
        raise EnvironmentGuideError(f"environment {env_id!r} has no canonical guide at {source}")
    rendered = _rewrite_local_links(
        source.read_text(encoding="utf-8"),
        source=source,
        mode=mode,
        virtual_page=environment_guide_virtual_path(env_id),
    )
    return rendered.rstrip() + "\n"


def _first_heading(markdown: str, *, source: Path) -> str:
    """Return a guide's first ATX H1, ignoring headings inside fenced code blocks."""
    fence: str | None = None
    for line in markdown.splitlines():
        if fence is not None:
            closer = rf"^\s{{0,3}}{re.escape(fence)}{{3,}}\s*$"
            if re.match(closer, line):
                fence = None
            continue
        opening = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if opening:
            fence = opening.group(1)[0]
            continue
        heading = re.match(r"^\s{0,3}#\s+(.+?)\s*#*\s*$", line)
        if heading:
            title = heading.group(1).strip()
            if "[" in title or "]" in title:
                raise EnvironmentGuideError(
                    f"environment guide heading {title!r} in {source} cannot contain brackets"
                )
            return title
    raise EnvironmentGuideError(f"environment guide at {source} must have an ATX H1 heading")


def render_environment_catalog(environments: Mapping[str, object] | Iterable[str]) -> str:
    """Populate the catalog shell from every dynamically discovered canonical guide."""
    env_ids = _environment_ids(environments)
    catalog = DOCS_DIR / ENVIRONMENT_CATALOG_PATH
    if not catalog.is_file():
        raise EnvironmentGuideError(f"environment catalog is missing: {catalog}")
    shell = catalog.read_text(encoding="utf-8")
    if shell.count(ENVIRONMENT_CATALOG_MARKER) != 1:
        raise EnvironmentGuideError(
            f"environment catalog {catalog} must contain the dynamic catalog marker exactly once"
        )
    entries = []
    for env_id in env_ids:
        source = env_environment_guide(env_id)
        if not source.is_file():
            raise EnvironmentGuideError(f"environment {env_id!r} has no canonical guide at {source}")
        title = _first_heading(source.read_text(encoding="utf-8"), source=source)
        entries.append(f"- [{title}]({environment_guide_slug(env_id)}.md)")
    listing = "\n".join(entries) if entries else "_No environments are available._"
    return shell.replace(ENVIRONMENT_CATALOG_MARKER, listing).rstrip() + "\n"
