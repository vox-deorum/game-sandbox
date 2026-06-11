"""Shared path constants for the dev scripts. The repo root is the parent of scripts/."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

SCHEMA_DIR = REPO_ROOT / "schema"
SCHEMA_FILES = ("step-state.schema.json", "recording-header.schema.json")

TS_GENERATED_DIR = SCHEMA_DIR / "ts" / "src" / "generated"
TS_GENERATED_TYPES = TS_GENERATED_DIR / "types.ts"

HARNESS_SCHEMA_DATA = REPO_ROOT / "harness" / "src" / "game_sandbox_harness" / "schema_data"
FIXTURES_DIR = SCHEMA_DIR / "fixtures"

TEMPLATES_DIR = REPO_ROOT / "templates"
EXAMPLES_DIR = REPO_ROOT / "examples"
BUILD_DIR = REPO_ROOT / "build"

# The environments package source, and the template's synced copy of the environment modules.
ENVIRONMENTS_SRC = REPO_ROOT / "environments" / "src" / "game_sandbox_environments"
TEMPLATE_SANDBOX_ENV = TEMPLATES_DIR / "sandbox_env"
# Environment modules that are import-self-contained (relative + third-party only) and so are
# copied verbatim into the template. The harness-dependent flappy_bird/__init__.py is not
# synced; the generate script writes a minimal __init__ in its place.
SYNCED_ENV_MODULES = (
    "single_agent.py",
    "flappy_bird/env.py",
    "flappy_bird/overlay.py",
)
