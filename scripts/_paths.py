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

# The environments source root, under which each environment is its own top-level package.
ENVIRONMENTS_SRC = REPO_ROOT / "environments" / "src"

# The registration point for environment templates: env id -> the import-self-contained
# modules (relative + third-party imports only), as paths under ENVIRONMENTS_SRC, copied
# verbatim into templates/<env>/sandbox/env/ at the same relative path. The harness-dependent
# flappy_bird/__init__.py is never synced; generate.py writes a minimal __init__ exposing a
# uniform surface (make_env, ENV_ID, PLAYER_SLOT, make_human_controller) in its place. The
# single-agent adapter and the human-input controller live inside each single-agent env package,
# so they sync as siblings under sandbox/env/<env>/. Adding an environment template means adding
# an entry here (plus its init text in generate.py) and a templates/<env>/ layer.
TEMPLATE_ENVS = {
    "flappy_bird": (
        "flappy_bird/single_agent.py",
        "flappy_bird/env.py",
        "flappy_bird/overlay.py",
        "flappy_bird/human.py",
    ),
    # Hearts ships its own pure-Python renderer (it does not inherit one from a wrapped Gymnasium
    # game), so render.py syncs alongside the env modules: the template's local play opens the
    # game through it. rules.py is the dependency-free engine env/overlay/render all import.
    "hearts": (
        "hearts/rules.py",
        "hearts/env.py",
        "hearts/overlay.py",
        "hearts/human.py",
        "hearts/render.py",
    ),
}

# Shared, import-self-contained sandbox helpers synced from the env source into the env-agnostic
# base layer (templates/base/sandbox/, not per-env): destination filename under sandbox/ -> source
# path under ENVIRONMENTS_SRC. These are reused verbatim by both the student's local play and the
# maintainer's scripts/play.py, so there is one source of truth. (Currently the HiDPI shim.)
TEMPLATE_BASE_MODULES = {
    "hidpi.py": "local_play/hidpi.py",
}


def template_sandbox_env(env: str) -> Path:
    """The generated game-package sync target (``sandbox/env/``) inside the ``env`` template layer."""
    return TEMPLATES_DIR / env / "sandbox" / "env"


def template_sandbox_base() -> Path:
    """The base template's ``sandbox/`` directory, where shared sandbox helpers are synced."""
    return TEMPLATE_BASE_DIR / "sandbox"
