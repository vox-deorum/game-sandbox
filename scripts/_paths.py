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
E2E_MAIN_DB = E2E_MAIN_DATA_DIR / "sandbox.db"
DEMO_DATA_DIR = E2E_DATA_DIR / "demo"
FRONTEND_DIST_DIR = REPO_ROOT / "frontend" / "dist"

# A template is composed from the env-agnostic base layer plus one per-environment layer.
# templates/base/ never ships alone; templates/<env>/ overlays it whole-file. The default
# environment is what the student repo's main branch (and "Use this template") instantiates.
TEMPLATE_BASE_DIR = TEMPLATES_DIR / "base"
DEFAULT_TEMPLATE_ENV = "flappy_bird"

# The canonical `template_version` source: every composed template and example inherits this
# manifest, and scripts/bump_template_version.py treats its integer as the repo's current version.
TEMPLATE_BASE_MANIFEST = TEMPLATE_BASE_DIR / "manifest.json"

# The live, evolving pinned dependency set. A release freezes a snapshot of this file into
# deps-v<N>/requirements.txt (stripping pip-compile's "# via" annotations); later PRs then evolve
# this file freely without touching the frozen image of any past version.
TEMPLATE_BASE_REQUIREMENTS = TEMPLATE_BASE_DIR / "requirements.txt"

# The per-version frozen session-base image snapshots live here as deps-v<N>/ directories
# (Dockerfile + frozen requirements.txt + builtin/ agents). deps-version.ts is the backend's
# registry of which versions have such a snapshot; both are edited at release time by
# scripts/bump_template_version.py.
SESSION_BASE_IMAGES_DIR = REPO_ROOT / "backend" / "images" / "session-base"
DEPS_VERSION_TS = REPO_ROOT / "backend" / "src" / "deps-version.ts"

# The e2e submission fixtures are submitted against seasons the backend seeds at the current
# DEPS_VERSION, so their manifests must track the current template version rather than pin one.
E2E_SUBMISSION_FIXTURES_DIR = REPO_ROOT / "frontend" / "e2e" / "fixtures" / "submission"

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
    # Spades mirrors Hearts: its own dependency-free rules engine plus the env/overlay/human/render
    # modules, so the template's local play opens the bid-then-play game through the synced renderer.
    "spades": (
        "spades/rules.py",
        "spades/env.py",
        "spades/overlay.py",
        "spades/human.py",
        "spades/render.py",
    ),
}

# Shared, import-self-contained sandbox helpers synced from the env source into the env-agnostic
# base layer (templates/base/sandbox/, not per-env): destination filename under sandbox/ -> source
# path under ENVIRONMENTS_SRC. These are reused verbatim by both the student's local play and the
# maintainer's scripts/play.py, so there is one source of truth: the HiDPI display shim and the two
# shared pygame renderers (a game-agnostic base and the four-seat card table the card games share).
TEMPLATE_BASE_MODULES = {
    "hidpi.py": "local_play/hidpi.py",
    "render_base.py": "local_play/render_base.py",
    "render_cards.py": "local_play/render_cards.py",
    # The dependency-free card codec and its Gymnasium spaces: the pure rules engines pull their
    # encoding from card_utils, and card_spaces declares the shared CARD/HAND/TRICK observation
    # shapes. Both sync into templates/base/sandbox/ (as sandbox.card_utils / sandbox.card_spaces)
    # beside each template's own game-specific sandbox/cards.py, which the distinct names keep apart.
    "card_utils.py": "local_play/card_utils.py",
    "card_spaces.py": "local_play/card_spaces.py",
}

# Each environment's student reference page. scripts/compose.py copies the page for the composed
# environment into the template as environment.md (rewriting its cross-doc links to absolute
# docs-site URLs), so the template's README, agent.py, and helper module point students at that
# local file instead of duplicating the observation/action reference. The page id is the env id
# with underscores turned into hyphens, matching the filenames MkDocs serves (flappy_bird ->
# flappy-bird.md); compose fails loudly if the page is missing.
DOCS_DIR = REPO_ROOT / "docs"
DOCS_STUDENT_ENV_PAGES = DOCS_DIR / "students" / "environments"


def template_sandbox_env(env: str) -> Path:
    """The generated game-package sync target (``sandbox/env/``) inside the ``env`` template layer."""
    return TEMPLATES_DIR / env / "sandbox" / "env"


def template_sandbox_base() -> Path:
    """The base template's ``sandbox/`` directory, where shared sandbox helpers are synced."""
    return TEMPLATE_BASE_DIR / "sandbox"


def env_docs_page(env: str) -> Path:
    """The student docs page copied into ``templates/<env>`` as ``environment.md`` at compose time."""
    return DOCS_STUDENT_ENV_PAGES / f"{env.replace('_', '-')}.md"
