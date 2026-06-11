"""The submission manifest and the agent loader.

``manifest.json`` at a repository root names the entry-point module, the agent class, and
the integer template-dependency-set version the repo targets. :func:`load_agent` parses and
validates the manifest, puts the repo root on ``sys.path``, imports the module, resolves the
class, and instantiates it with no arguments — all episode state is established in
``reset(seed)``. This is exactly the mechanism the Stage 3 session container uses per slot,
one repo root each, loaded by this same function. Stage 2 does not sandbox the import:
participant code runs in-process with the harness by design; isolation is the container's
job.

Every failure raises :class:`ManifestError` naming the repo, the field, and the failure,
because in Stage 5 these messages are surfaced to the participant whose build failed.
"""

from __future__ import annotations

import importlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from game_sandbox_harness.agent import has_chat, has_learn

_MANIFEST_FILENAME = "manifest.json"
_REQUIRED_FIELDS = ("entry_point", "class_name", "template_version")


class ManifestError(Exception):
    """Raised when a manifest is missing, malformed, or names an unloadable agent."""


@dataclass(frozen=True)
class Manifest:
    """A parsed, validated ``manifest.json``."""

    entry_point: str
    class_name: str
    template_version: int


def load_manifest(repo_root: Path | str) -> Manifest:
    """Parse and validate ``manifest.json`` under ``repo_root``."""
    root = Path(repo_root)
    path = root / _MANIFEST_FILENAME
    if not path.is_file():
        raise ManifestError(f"no {_MANIFEST_FILENAME} at repo root {root}")

    try:
        parsed: object = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ManifestError(f"{path} is not valid JSON: {error}") from error

    if not isinstance(parsed, dict):
        raise ManifestError(f"{path} must be a JSON object, got {type(parsed).__name__}")
    raw = cast("dict[str, Any]", parsed)

    missing = [field for field in _REQUIRED_FIELDS if field not in raw]
    if missing:
        raise ManifestError(f"{path} is missing required field(s): {', '.join(missing)}")

    unknown = sorted(set(raw) - set(_REQUIRED_FIELDS))
    if unknown:
        raise ManifestError(
            f"{path} has unknown key(s): {', '.join(unknown)}. Allowed keys are "
            f"{', '.join(_REQUIRED_FIELDS)}"
        )

    entry_point = raw["entry_point"]
    class_name = raw["class_name"]
    template_version = raw["template_version"]

    if not isinstance(entry_point, str) or not entry_point:
        raise ManifestError(f"{path} field 'entry_point' must be a non-empty string")
    if not isinstance(class_name, str) or not class_name:
        raise ManifestError(f"{path} field 'class_name' must be a non-empty string")
    # bool is an int subclass; a JSON true/false must not pass as a version.
    if not isinstance(template_version, int) or isinstance(template_version, bool):
        raise ManifestError(f"{path} field 'template_version' must be an integer")

    return Manifest(
        entry_point=entry_point,
        class_name=class_name,
        template_version=template_version,
    )


def load_agent(repo_root: Path | str) -> Any:
    """Load and instantiate the agent named by ``repo_root``'s manifest.

    Prepends the repo root to ``sys.path``, imports the entry-point module, resolves the
    class, and constructs it with no arguments. Raises :class:`ManifestError` on any failure
    (import error, missing class, or a class missing a callable ``reset``/``act``).
    """
    root = Path(repo_root).resolve()
    manifest = load_manifest(root)

    root_str = str(root)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)

    try:
        module = importlib.import_module(manifest.entry_point)
    except ImportError as error:
        raise ManifestError(
            f"repo {root}: could not import entry-point module {manifest.entry_point!r}: {error}"
        ) from error

    try:
        agent_cls = getattr(module, manifest.class_name)
    except AttributeError as error:
        raise ManifestError(
            f"repo {root}: module {manifest.entry_point!r} has no class {manifest.class_name!r}"
        ) from error

    try:
        agent = agent_cls()
    except Exception as error:  # noqa: BLE001 - surfaced verbatim to the participant
        raise ManifestError(
            f"repo {root}: constructing {manifest.class_name!r} failed: {error}"
        ) from error

    if not callable(getattr(agent, "reset", None)):
        raise ManifestError(f"repo {root}: {manifest.class_name!r} has no callable 'reset' method")
    if not callable(getattr(agent, "act", None)):
        raise ManifestError(f"repo {root}: {manifest.class_name!r} has no callable 'act' method")

    return agent


def describe_agent_hooks(agent: object) -> dict[str, bool]:
    """Return which optional hooks an agent provides, for logging and CLI summaries."""
    return {"learn": has_learn(agent), "chat": has_chat(agent)}
