"""Discover environment packages directly from ``environments``.

The generator must recognize a newly-created package before the workspace wheel is rebuilt, so this
module imports packages from source instead of asking installed entry points what they contain.
"""

from __future__ import annotations

import fnmatch
import importlib
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from _paths import ENVIRONMENT_PACKAGES_DIR, ENVIRONMENTS_IGNORE_FILE, TemplateEnvironmentSpec

_PUBLISHED_EXAMPLE_NAME = re.compile(r"[a-z0-9][a-z0-9._-]*")


@dataclass(frozen=True)
class DiscoveredEnvironment:
    """One recognized environment together with its registry entry and template facts."""

    env_id: str
    entry: Any
    spec: TemplateEnvironmentSpec
    published_examples: tuple[str, ...]


def _ignore_patterns(path: Path = ENVIRONMENTS_IGNORE_FILE) -> tuple[str, ...]:
    """Read the small gitignore-style negative catalog, ignoring blank lines and comments."""
    if not path.is_file():
        return ()
    return tuple(
        line.strip().replace("\\", "/")
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )


def _is_ignored(relative: str, patterns: tuple[str, ...]) -> bool:
    """Return whether one source-root-relative package path matches a negative catalog pattern."""
    candidates = (relative, relative.rstrip("/"), f"{relative.rstrip('/')}/")
    for pattern in patterns:
        normalized = pattern.lstrip("/").rstrip("/")
        if any(fnmatch.fnmatchcase(candidate, normalized) for candidate in candidates):
            return True
        if pattern.endswith("/") and relative.rstrip("/") == normalized:
            return True
    return False


def package_dirs() -> list[Path]:
    """Return every top-level Python package under the environments package root."""
    if not ENVIRONMENT_PACKAGES_DIR.is_dir():
        return []
    return sorted(
        path
        for path in ENVIRONMENT_PACKAGES_DIR.iterdir()
        if path.is_dir() and (path / "__init__.py").is_file()
    )


def recognized_package_dirs() -> list[Path]:
    """Return packages that are environments, excluding paths matched by ``.envignore``."""
    patterns = _ignore_patterns()
    return [path for path in package_dirs() if not _is_ignored(path.name, patterns)]


def _import_source_package(package_dir: Path) -> Any:
    """Import one package from source, rejecting a same-named package from another location."""
    package_name = package_dir.name
    cached_modules = {
        name: module
        for name, module in sys.modules.items()
        if name == package_name or name.startswith(f"{package_name}.")
    }
    for name in cached_modules:
        del sys.modules[name]

    source_root = str(ENVIRONMENT_PACKAGES_DIR)
    sys.path.insert(0, source_root)
    try:
        importlib.invalidate_caches()
        module = importlib.import_module(package_name)
        module_file = Path(getattr(module, "__file__", "")).resolve()
        expected = (package_dir / "__init__.py").resolve()
        if module_file != expected:
            raise RuntimeError(
                f"environment package {package_name!r} imported from {module_file}, not {expected}"
            )
    except BaseException:
        for name in tuple(sys.modules):
            if name == package_name or name.startswith(f"{package_name}."):
                del sys.modules[name]
        sys.modules.update(cached_modules)
        raise
    finally:
        sys.path.pop(0)
    return module


def _template_spec(package_dir: Path, meta: Any) -> TemplateEnvironmentSpec:
    """Build template facts from environment metadata and directly-owned source files."""
    modules = tuple(
        f"{package_dir.name}/{path.name}"
        for path in sorted(package_dir.iterdir())
        if path.is_file()
        and path.name not in {"__init__.py", "environment.md"}
        and not path.name.endswith((".pyc", ".pyo"))
    )
    human_players = getattr(meta, "human_players", ())
    pyright_files = (
        ("agent.py", "sandbox/cards.py", "sandbox/card_types.py")
        if package_dir.name in {"hearts", "spades"}
        else ("agent.py", "sandbox/features.py", "sandbox/observation_types.py")
        if package_dir.name == "flappy_bird"
        else ("agent.py", "sandbox/crane.py", "sandbox/observation_types.py")
        if package_dir.name == "skirmish_crane"
        else ()
    )
    # Flappy's and Skirmish's observation TypedDicts (observation_types.py) live beside env.py in
    # the source package, so they are already swept into `modules` above for the env-side
    # sandbox/env/ copy; this additionally places a copy at sandbox/observation_types.py, the
    # direct import point for Skirmish agents (flappy re-exports it through sandbox.features).
    env_sandbox_modules = (
        {"observation_types.py": "flappy_bird/observation_types.py"}
        if package_dir.name == "flappy_bird"
        else {"observation_types.py": "skirmish_crane/observation_types.py"}
        if package_dir.name == "skirmish_crane"
        else {}
    )
    return TemplateEnvironmentSpec(
        display_name=meta.display_name,
        inner_package=package_dir.name,
        modules=modules,
        player_id=human_players[0] if human_players else "player_0",
        env_sandbox_modules=env_sandbox_modules,
        pyright_files=pyright_files,
    )


def _published_examples(package_dir: Path, module: Any) -> tuple[str, ...]:
    """Validate and return the environment's explicit publication allowlist."""
    if not hasattr(module, "PUBLISHED_EXAMPLES"):
        raise RuntimeError(f"environment package {package_dir.name!r} must export PUBLISHED_EXAMPLES")

    published_examples = module.PUBLISHED_EXAMPLES
    if not isinstance(published_examples, tuple):
        raise RuntimeError(f"environment package {package_dir.name!r} PUBLISHED_EXAMPLES must be a tuple")

    seen: set[str] = set()
    examples_dir = package_dir / "examples"
    for name in published_examples:
        if not isinstance(name, str) or not name.strip():
            raise RuntimeError(
                f"environment package {package_dir.name!r} PUBLISHED_EXAMPLES must contain nonblank strings"
            )
        if name in (".", "..") or "/" in name or "\\" in name:
            raise RuntimeError(
                f"environment package {package_dir.name!r} PUBLISHED_EXAMPLES entry {name!r} must name an "
                "immediate examples child directory"
            )
        if _PUBLISHED_EXAMPLE_NAME.fullmatch(name) is None or ".." in name or name.endswith((".lock", ".")):
            raise RuntimeError(
                f"environment package {package_dir.name!r} PUBLISHED_EXAMPLES entry {name!r} must use a "
                "safe Git branch component"
            )
        if name in seen:
            raise RuntimeError(
                f"environment package {package_dir.name!r} PUBLISHED_EXAMPLES contains duplicate entry "
                f"{name!r}"
            )
        if not (examples_dir / name).is_dir():
            raise RuntimeError(
                f"environment package {package_dir.name!r} PUBLISHED_EXAMPLES entry {name!r} has "
                "no directory "
                f"under {examples_dir}"
            )
        seen.add(name)
    return published_examples


def discover_environments() -> dict[str, DiscoveredEnvironment]:
    """Import every recognized package and return it keyed by its metadata environment id."""
    discovered: dict[str, DiscoveredEnvironment] = {}
    for package_dir in recognized_package_dirs():
        module = _import_source_package(package_dir)
        entry = getattr(module, "ENTRY", None)
        meta = getattr(module, "META", None)
        if entry is None or meta is None:
            raise RuntimeError(f"environment package {package_dir.name!r} must export ENTRY and META")
        env_id = meta.env_id
        if env_id != package_dir.name:
            raise RuntimeError(f"environment package {package_dir.name!r} has metadata id {env_id!r}")
        if env_id in discovered:
            raise RuntimeError(f"duplicate environment id {env_id!r}")
        discovered[env_id] = DiscoveredEnvironment(
            env_id,
            entry,
            _template_spec(package_dir, meta),
            _published_examples(package_dir, module),
        )
    return dict(sorted(discovered.items()))
