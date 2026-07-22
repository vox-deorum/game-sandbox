"""Discover environment packages directly from ``environments/src``.

The generator must recognize a newly-created package before the workspace wheel is rebuilt, so this
module imports packages from source instead of asking installed entry points what they contain.
"""

from __future__ import annotations

import fnmatch
import importlib
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from _paths import ENVIRONMENTS_IGNORE_FILE, ENVIRONMENTS_SRC, TemplateEnvironmentSpec


@dataclass(frozen=True)
class DiscoveredEnvironment:
    """One recognized environment together with its registry entry and template facts."""

    env_id: str
    entry: Any
    spec: TemplateEnvironmentSpec


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
    """Return every top-level Python package under the environments source root."""
    if not ENVIRONMENTS_SRC.is_dir():
        return []
    return sorted(
        path for path in ENVIRONMENTS_SRC.iterdir() if path.is_dir() and (path / "__init__.py").is_file()
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

    source_root = str(ENVIRONMENTS_SRC)
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
        if path.is_file() and path.name != "__init__.py" and not path.name.endswith((".pyc", ".pyo"))
    )
    human_slots = getattr(meta, "human_slots", ())
    return TemplateEnvironmentSpec(
        display_name=meta.display_name,
        inner_package=package_dir.name,
        modules=modules,
        player_slot=human_slots[0] if human_slots else "player_0",
    )


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
        discovered[env_id] = DiscoveredEnvironment(env_id, entry, _template_spec(package_dir, meta))
    return dict(sorted(discovered.items()))
