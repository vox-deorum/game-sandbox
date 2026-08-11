"""Compose a runnable template or example from the base layer plus overlays.

A template is two layers: the env-agnostic ``templates/base/`` plus one colocated
``environments/<env>/template/`` layer, combined with whole-file replacement (an env-layer
file wins). Composition also generates the environment package, relocatable harness, and shared
helpers into the build output. An example is a composed template plus an
``environments/<env>/examples/<name>/`` overlay on top, again
whole-file, with one merge rule for requirements.

    uv run python scripts/compose.py                 # list envs and examples
    uv run python scripts/compose.py <env>           # template -> build/templates/<env>/
    uv run python scripts/compose.py <env> <name>    # example  -> build/examples/<env>/<name>/

The one merge rule: lines from an example's ``requirements.extra.txt`` are appended to the
composed ``requirements.txt``. Extras extend the dependency set; they never override it, so
if a package is pinned in both, compose fails loudly. Environment layers never carry
requirements files — the dependency set is global, lives in ``templates/base/``, and is
versioned by the single ``template-v<N>`` axis. This is the same code path CI and the publish
workflow use, so a student's clone is byte-identical to what CI tested.

Each composed template also carries ``environment.md`` and ``llm.md``, copied from the student
documentation with cross-document links rewritten to absolute docs-site URLs. Template files point
at those local copies, keeping the public guides as the single source of truth.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path, PurePosixPath

from _environment_guides import EnvironmentGuideError, render_environment_guide
from _envs import discover_environments
from _paths import (
    BUILD_DIR,
    DOCS_DIR,
    ENVIRONMENT_PACKAGES_DIR,
    REPO_ROOT,
    SESSION_BASE_IMAGES_DIR,
    TEMPLATE_BASE_DIR,
    TEMPLATE_BASE_MANIFEST,
    env_examples_dir,
    env_template_layer,
)
from _template_gen import write_base_helpers, write_env_package, write_harness

_EXTRA_REQUIREMENTS = "requirements.extra.txt"
_REQUIREMENTS = "requirements.txt"

# Templates carry the {{DOCS_URL}} token wherever they link to the docs site; compose resolves it
# to the real address from mkdocs.yml so a student's cloned template points at the published docs.
# The monorepo sources keep the token (there is no single site URL to hard-code into them), and
# every composed artifact CI tests or the publish workflow ships carries the substituted URL.
_DOCS_URL_TOKEN = "{{DOCS_URL}}"
_MKDOCS_CONFIG = REPO_ROOT / "mkdocs.yml"
# The token only ever appears in prose and Python, so those are the file types we rewrite. Any
# other file carrying it is caught by the post-substitution sweep below rather than silently kept.
_SUBSTITUTED_SUFFIXES = (".md", ".py")


class ComposeError(Exception):
    """Raised when a template or example cannot be composed (bad env, conflicting pin, ...)."""


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
    base_names = {name for line in base_text.splitlines() if (name := _requirement_name(line)) is not None}
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


def _docs_url() -> str:
    """Return the docs site URL from mkdocs.yml, with a trailing slash, for token substitution."""
    if not _MKDOCS_CONFIG.is_file():
        raise ComposeError(f"no mkdocs.yml at {_MKDOCS_CONFIG}; cannot resolve the {_DOCS_URL_TOKEN} token")
    match = re.search(r"^site_url:\s*(\S+)\s*$", _MKDOCS_CONFIG.read_text(encoding="utf-8"), re.MULTILINE)
    if match is None:
        raise ComposeError(
            f"mkdocs.yml has no site_url, so templates cannot resolve the {_DOCS_URL_TOKEN} token. "
            f"Add a site_url to mkdocs.yml (a placeholder is fine until the site is public)."
        )
    url = match.group(1)
    return url if url.endswith("/") else url + "/"


def _substitute_docs_url(out_dir: Path) -> None:
    """Replace the {{DOCS_URL}} token in a composed tree and fail loudly if any copy survives.

    Prose and Python files are rewritten in place; then the tree is swept so a token left in any
    other source file type surfaces as an error rather than shipping to a student unresolved.
    Compiled ``__pycache__`` artifacts are ignored: a ``.pyc`` legitimately mirrors the token from
    its source module's string constants and is regenerated from the already-substituted source.
    """
    url = _docs_url()
    sources = [p for p in out_dir.rglob("*") if p.is_file() and "__pycache__" not in p.parts]
    for path in sorted(p for p in sources if p.suffix in _SUBSTITUTED_SUFFIXES):
        text = path.read_text(encoding="utf-8")
        if _DOCS_URL_TOKEN in text:
            path.write_text(text.replace(_DOCS_URL_TOKEN, url), encoding="utf-8", newline="\n")

    token_bytes = _DOCS_URL_TOKEN.encode("utf-8")
    survivors = sorted(str(p.relative_to(out_dir)) for p in sources if token_bytes in p.read_bytes())
    if survivors:
        raise ComposeError(
            f"the {_DOCS_URL_TOKEN} token survived substitution in {survivors}; it is only rewritten "
            f"in {_SUBSTITUTED_SUFFIXES} files. Move the link into a supported file type."
        )


# The environment's student docs page is shipped inside the composed template as environment.md, so
# the README and agent.py can point at a local file instead of duplicating the observation/action
# reference. The page is copied verbatim except for its cross-doc Markdown links (e.g.
# ../agent-interface.md), which are rewritten to {{DOCS_URL}} links so they still resolve from a
# student's clone; _substitute_docs_url below then turns those into real URLs. In-page (#anchor) and
# external (http...) links are left untouched.
_ENVIRONMENT_DOC = "environment.md"
_LLM_DOC = "llm.md"
_MD_LINK = re.compile(r"\]\(([^)]+)\)")


def _normalize_posix_parts(parts: tuple[str, ...]) -> list[str]:
    """Collapse ``.`` and ``..`` segments in a POSIX path already split into parts."""
    resolved: list[str] = []
    for part in parts:
        if part in ("", "."):
            continue
        if part == "..":
            if resolved:
                resolved.pop()
            continue
        resolved.append(part)
    return resolved


def _localize_docs_links(text: str, page_dir: PurePosixPath) -> str:
    """Rewrite intra-docs relative Markdown links so a page copied out of ``docs/`` still resolves.

    A link whose target is another docs page (``foo.md`` / ``../foo.md``, optionally with an
    ``#anchor``) is resolved against ``page_dir`` (the page's directory within ``docs/``) and
    re-emitted as a ``{{DOCS_URL}}`` link to the MkDocs directory URL for that page. External links
    and bare in-page anchors are returned unchanged.
    """

    def rewrite(match: re.Match[str]) -> str:
        target = match.group(1)
        if target.startswith(("http://", "https://", "//", "mailto:", "#")):
            return match.group(0)
        path_part, _, anchor = target.partition("#")
        if not path_part.endswith(".md"):
            return match.group(0)
        parts = _normalize_posix_parts((*page_dir.parts, *PurePosixPath(path_part).parts))
        parts[-1] = parts[-1][: -len(".md")]  # drop the .md suffix
        if parts[-1] == "index":  # MkDocs serves index.md as the directory root
            parts.pop()
        site_path = "/".join(parts)
        anchor_suffix = f"#{anchor}" if anchor else ""
        return f"]({_DOCS_URL_TOKEN}{site_path}/{anchor_suffix})"

    return _MD_LINK.sub(rewrite, text)


def _ship_docs_page(page: Path, out_dir: Path, dest_name: str) -> None:
    """Localize one student docs page's cross-doc links and write it into a composed template."""
    page_dir = PurePosixPath(page.relative_to(DOCS_DIR).parent.as_posix())
    localized = _localize_docs_links(page.read_text(encoding="utf-8"), page_dir)
    (out_dir / dest_name).write_text(localized, encoding="utf-8", newline="\n")


def _copy_environment_page(env: str, out_dir: Path) -> None:
    """Render the environment-root guide into the composed template as ``environment.md``."""
    try:
        rendered = render_environment_guide(env, "composed_kit")
    except EnvironmentGuideError as error:
        raise ComposeError(str(error)) from error
    (out_dir / _ENVIRONMENT_DOC).write_text(rendered, encoding="utf-8", newline="\n")


def _copy_llm_page(out_dir: Path) -> None:
    """Copy the shared student LLM guide into a composed template as ``llm.md``."""
    page = DOCS_DIR / "students" / _LLM_DOC
    if not page.is_file():
        raise ComposeError(f"no student LLM guide at {page}; every composed template ships {_LLM_DOC}")
    _ship_docs_page(page, out_dir, _LLM_DOC)


def _overlay_files(src_dir: Path, out_dir: Path, *, skip_extra: bool = False) -> None:
    """Copy every file under ``src_dir`` onto ``out_dir`` with whole-file replacement."""
    for src in sorted(
        p
        for p in src_dir.rglob("*")
        if p.is_file()
        and "__pycache__" not in p.relative_to(src_dir).parts
        and p.suffix not in (".pyc", ".pyo", ".pyd")
    ):
        relative = src.relative_to(src_dir)
        if skip_extra and relative.name == _EXTRA_REQUIREMENTS:
            continue
        dest = out_dir / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)


def _copy_builtin_agents(env: str, meta: object, sandbox: Path) -> None:
    """Ship this environment's frozen builtin repositories with the student launcher."""
    from game_sandbox_harness.environment import EnvironmentMeta

    if not isinstance(meta, EnvironmentMeta):
        raise TypeError(f"expected EnvironmentMeta for {env!r}, got {type(meta).__name__}")
    try:
        version = json.loads(TEMPLATE_BASE_MANIFEST.read_text(encoding="utf-8"))["template_version"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise ComposeError(f"cannot read template_version from {TEMPLATE_BASE_MANIFEST}: {error}") from error
    if not isinstance(version, int) or isinstance(version, bool):
        raise ComposeError(f"{TEMPLATE_BASE_MANIFEST} template_version must be an integer")

    source_root = SESSION_BASE_IMAGES_DIR / f"deps-v{version}" / "builtin" / env
    destination = sandbox / "builtins"
    destination.mkdir(parents=True, exist_ok=True)
    for declaration in meta.builtin_agents:
        name = declaration.name
        source = source_root / name
        if not source.is_dir():
            raise ComposeError(f"environment {env!r} declares builtin {name!r}, but {source} does not exist")
        shutil.copytree(
            source,
            destination / name,
            ignore=shutil.ignore_patterns("__pycache__", "*.py[cod]"),
        )


def list_envs() -> list[str]:
    """Every recognized environment package."""
    return sorted(discover_environments())


def list_examples() -> list[tuple[str, str]]:
    """Every example as an ``(env, name)`` pair colocated with its environment."""
    pairs: list[tuple[str, str]] = []
    for env in list_envs():
        examples_dir = env_examples_dir(env)
        if not examples_dir.is_dir():
            continue
        for name_dir in sorted(p for p in examples_dir.iterdir() if p.is_dir()):
            pairs.append((env, name_dir.name))
    return pairs


def list_published_examples() -> list[tuple[str, str]]:
    """Every explicitly allowed publication example as a canonical ``(env, name)`` pair."""
    return sorted(
        (env, name)
        for env, discovered in discover_environments().items()
        for name in discovered.published_examples
    )


def _prepare_output_dir(out_dir: Path) -> Path:
    """Validate and prepare one composition target without risking source-tree deletion."""
    target = out_dir.resolve()
    repo_root = REPO_ROOT.resolve()
    build_root = BUILD_DIR.resolve()

    if target == repo_root or repo_root.is_relative_to(target):
        raise ComposeError(f"refusing to replace repository root or its ancestor: {target}")

    if target == build_root:
        raise ComposeError(f"refusing to replace the build root itself: {target}")

    in_build = target != build_root and target.is_relative_to(build_root)
    if target.is_relative_to(repo_root) and not in_build:
        raise ComposeError(f"output directory inside the repository must be under {build_root}: {target}")

    if in_build:
        if target.exists():
            shutil.rmtree(target)
    elif target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise ComposeError(f"refusing to replace non-empty output directory outside build: {target}")

    target.mkdir(parents=True, exist_ok=True)
    return target


def compose_template(env: str, *, out_dir: Path | None = None) -> Path:
    """Compose the ``env`` template into ``build/templates/<env>/`` and return that path.

    ``templates/base/`` is the base layer; the colocated env layer overlays it whole-file. The
    env layer must not carry any ``requirements*`` file: the dependency set is global and
    lives only in the base layer.
    """
    if not TEMPLATE_BASE_DIR.is_dir():
        raise ComposeError(f"no base template layer under {TEMPLATE_BASE_DIR}")
    env_dir = env_template_layer(env)
    if env not in list_envs() or not env_dir.is_dir():
        raise ComposeError(f"no environment template layer named {env!r} under {ENVIRONMENT_PACKAGES_DIR}")

    stray = sorted({p.name for p in env_dir.rglob("requirements*") if p.is_file()})
    if stray:
        raise ComposeError(
            f"environment layer {env!r} carries requirements file(s) {stray}; the dependency "
            f"set is global and lives only in templates/base/. Remove them."
        )

    out_dir = _prepare_output_dir(out_dir or BUILD_DIR / "templates" / env)

    # 1. The base layer is the foundation.
    shutil.copytree(
        TEMPLATE_BASE_DIR,
        out_dir,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.py[cod]"),
    )
    # 2. Generated package pieces join the fresh output.
    discovered = discover_environments()[env]
    sandbox = out_dir / "sandbox"
    write_harness(sandbox / "harness")
    write_base_helpers(sandbox, discovered.spec)
    write_env_package(env, discovered.spec, discovered.entry.meta, sandbox / "env")
    _copy_builtin_agents(env, discovered.entry.meta, sandbox)
    # 3. The hand-authored env layer overlays it, whole-file.
    _overlay_files(env_dir, out_dir)
    # 4. Ship the environment's student docs page as environment.md: the local reference the
    #    template README and agent.py point at instead of duplicating it.
    _copy_environment_page(env, out_dir)
    # 5. Ship the shared LLM guide beside the README so students can use it without finding the
    #    documentation site first.
    _copy_llm_page(out_dir)
    # 6. Resolve the docs-site link token now that every layer and copied guide is in place.
    _substitute_docs_url(out_dir)
    return out_dir


def compose_example(env: str, name: str, *, out_dir: Path | None = None) -> Path:
    """Compose example ``env/name`` into ``build/examples/<env>/<name>/`` and return it."""
    example_dir = env_examples_dir(env) / name
    if not example_dir.is_dir():
        raise ComposeError(f"no example named {name!r} for env {env!r} under {env_examples_dir(env)}")

    # 1. Compose the template directly into the requested example output.
    out_dir = compose_template(env, out_dir=out_dir or BUILD_DIR / "examples" / env / name)

    # 2. Overlay every example file except the extras file, with whole-file replacement.
    _overlay_files(example_dir, out_dir, skip_extra=True)

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

    # 4. Resolve the docs-site link token again, in case an example overlay reintroduced it.
    _substitute_docs_url(out_dir)
    return out_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compose a template or example.")
    parser.add_argument("env", nargs="?", help="environment id; omit to list envs and examples")
    parser.add_argument("name", nargs="?", help="example name; omit to compose the bare template for <env>")
    parser.add_argument("--out", type=Path, help="write the composed output to this directory")
    args = parser.parse_args(argv)

    if args.env is None:
        print("environments:")
        for env in list_envs():
            print(f"  {env}")
        print("examples:")
        for env, name in list_examples():
            print(f"  {env}/{name}")
        return 0

    try:
        if args.name is None:
            out_dir = compose_template(args.env, out_dir=args.out)
            print(f"composed template {args.env} -> {out_dir}")
        else:
            out_dir = compose_example(args.env, args.name, out_dir=args.out)
            print(f"composed example {args.env}/{args.name} -> {out_dir}")
    except ComposeError as error:
        print(f"compose failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
