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

# The backend serves environment metadata without ever running Python: generate.py writes the
# registry's public-facing fields here as a committed, byte-stable JSON artifact, kept fresh by
# the generated-code-fresh CI job like every other generated output.
BACKEND_GENERATED_DIR = REPO_ROOT / "backend" / "src" / "generated"
BACKEND_ENVIRONMENTS_JSON = BACKEND_GENERATED_DIR / "environments.json"

TEMPLATES_DIR = REPO_ROOT / "templates"
EXAMPLES_DIR = REPO_ROOT / "examples"
BUILD_DIR = REPO_ROOT / "build"

# The frontend-e2e job leaves a populated SQLite database (submissions, recordings, released
# seasons) under its "main" backend's data dir; `npm run demo` (scripts/demo.py) reuses that
# instead of seeding fresh, snapshotting it into a sibling demo/ dir on every launch. The whole
# .data/ tree is gitignored.
E2E_DATA_DIR = REPO_ROOT / "frontend" / "e2e" / ".data"
E2E_MAIN_DATA_DIR = E2E_DATA_DIR / "main"
E2E_RESTRICTED_DATA_DIR = E2E_DATA_DIR / "restricted"
E2E_MAIN_DB = E2E_MAIN_DATA_DIR / "sandbox.db"
DEMO_DATA_DIR = E2E_DATA_DIR / "demo"
FRONTEND_DIST_DIR = REPO_ROOT / "frontend" / "dist"

# A template is composed from the env-agnostic base layer plus one per-environment layer.
# templates/base/ never ships alone; templates/<env>/ overlays it whole-file. The default
# environment is what the student repo's main branch (and "Use this template") instantiates.
TEMPLATE_BASE_DIR = TEMPLATES_DIR / "base"
DEFAULT_TEMPLATE_ENV = "flappy_bird"

# The environments package source, and the per-env synced copies of the environment modules.
ENVIRONMENTS_SRC = REPO_ROOT / "environments" / "src" / "game_sandbox_environments"

# The registration point for environment templates: env id -> the import-self-contained
# modules (relative + third-party imports only) copied verbatim into templates/<env>/sandbox_env/.
# The harness-dependent flappy_bird/__init__.py is never synced; generate.py writes a minimal
# __init__ exposing a uniform surface (make_env, ENV_ID, PLAYER_SLOT) in its place. Adding an
# environment template means adding an entry here (plus its init text in generate.py) and a
# templates/<env>/ layer.
TEMPLATE_ENVS = {
    "flappy_bird": (
        "single_agent.py",
        "flappy_bird/env.py",
        "flappy_bird/overlay.py",
    ),
}


def template_sandbox_env(env: str) -> Path:
    """The generated sandbox_env/ sync target inside the ``env`` template layer."""
    return TEMPLATES_DIR / env / "sandbox_env"
