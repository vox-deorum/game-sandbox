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
