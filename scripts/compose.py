"""Compose a runnable template or example from the base layer plus overlays.

A template is two layers: the env-agnostic ``templates/base/`` plus one per-environment
``templates/<env>/`` layer, combined with whole-file replacement (an env-layer file wins).
An example is a composed template plus an ``examples/<env>/<name>/`` overlay on top, again
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
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

from _paths import BUILD_DIR, EXAMPLES_DIR, REPO_ROOT, TEMPLATE_BASE_DIR, TEMPLATES_DIR

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


def _overlay_files(src_dir: Path, out_dir: Path, *, skip_extra: bool = False) -> None:
    """Copy every file under ``src_dir`` onto ``out_dir`` with whole-file replacement."""
    for src in sorted(p for p in src_dir.rglob("*") if p.is_file()):
        relative = src.relative_to(src_dir)
        if skip_extra and relative.name == _EXTRA_REQUIREMENTS:
            continue
        dest = out_dir / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)


def list_envs() -> list[str]:
    """Every environment template layer: ``templates/<env>/`` other than ``base``."""
    if not TEMPLATES_DIR.is_dir():
        return []
    return sorted(
        p.name
        for p in TEMPLATES_DIR.iterdir()
        if p.is_dir() and p.name != TEMPLATE_BASE_DIR.name and not p.name.startswith((".", "__"))
    )


def list_examples() -> list[tuple[str, str]]:
    """Every example as an ``(env, name)`` pair under ``examples/<env>/<name>/``."""
    if not EXAMPLES_DIR.is_dir():
        return []
    pairs: list[tuple[str, str]] = []
    for env_dir in sorted(p for p in EXAMPLES_DIR.iterdir() if p.is_dir()):
        for name_dir in sorted(p for p in env_dir.iterdir() if p.is_dir()):
            pairs.append((env_dir.name, name_dir.name))
    return pairs


def compose_template(env: str) -> Path:
    """Compose the ``env`` template into ``build/templates/<env>/`` and return that path.

    ``templates/base/`` is the base layer; ``templates/<env>/`` overlays it whole-file. The
    env layer must not carry any ``requirements*`` file — the dependency set is global and
    lives only in the base layer.
    """
    if not TEMPLATE_BASE_DIR.is_dir():
        raise ComposeError(f"no base template layer under {TEMPLATE_BASE_DIR}")
    env_dir = TEMPLATES_DIR / env
    if env not in list_envs() or not env_dir.is_dir():
        raise ComposeError(f"no environment template layer named {env!r} under {TEMPLATES_DIR}")

    stray = sorted({p.name for p in env_dir.rglob("requirements*") if p.is_file()})
    if stray:
        raise ComposeError(
            f"environment layer {env!r} carries requirements file(s) {stray}; the dependency "
            f"set is global and lives only in templates/base/. Remove them."
        )

    out_dir = BUILD_DIR / "templates" / env
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    # 1. The base layer is the foundation.
    shutil.copytree(TEMPLATE_BASE_DIR, out_dir, dirs_exist_ok=True)
    # 2. The env layer overlays it, whole-file.
    _overlay_files(env_dir, out_dir)
    # 3. Resolve the docs-site link token now that every layer is in place.
    _substitute_docs_url(out_dir)
    return out_dir


def compose_example(env: str, name: str) -> Path:
    """Compose example ``env/name`` into ``build/examples/<env>/<name>/`` and return it."""
    example_dir = EXAMPLES_DIR / env / name
    if not example_dir.is_dir():
        raise ComposeError(f"no example named {name!r} for env {env!r} under {EXAMPLES_DIR}")

    out_dir = BUILD_DIR / "examples" / env / name
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    # 1. The composed template is the base.
    template_dir = compose_template(env)
    shutil.copytree(template_dir, out_dir, dirs_exist_ok=True)

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
            out_dir = compose_template(args.env)
            print(f"composed template {args.env} -> {out_dir}")
        else:
            out_dir = compose_example(args.env, args.name)
            print(f"composed example {args.env}/{args.name} -> {out_dir}")
    except ComposeError as error:
        print(f"compose failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
