"""Shared path constants for the dev scripts. The repo root is the parent of scripts/."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# The canonical JSON Schema files are generated from the zod definitions under
# schema/ts/src/schemas/. They are outputs, not inputs: edit the zod source and regenerate.
SCHEMA_DIR = REPO_ROOT / "schema"
SCHEMA_FILES = ("step-state.schema.json", "recording-header.schema.json", "environment-meta.schema.json")

SCHEMA_TS_DIR = SCHEMA_DIR / "ts"

HARNESS_SCHEMA_DATA = REPO_ROOT / "harness" / "src" / "game_sandbox_harness" / "schema_data"
FIXTURES_DIR = SCHEMA_DIR / "fixtures"

# The backend serves environment metadata without ever running Python: generate.py writes the
# registry's public-facing fields here as a committed, byte-stable JSON artifact, kept fresh by
# the generated-code-fresh CI job like every other generated output.
BACKEND_GENERATED_DIR = REPO_ROOT / "backend" / "src" / "environments" / "generated"
BACKEND_ENVIRONMENTS_JSON = BACKEND_GENERATED_DIR / "environments.json"

TEMPLATES_DIR = REPO_ROOT / "templates"
BUILD_DIR = REPO_ROOT / "build"

# The frontend-e2e job leaves a populated SQLite database (submissions, recordings, released
# seasons) under its "main" backend's data dir; `npm run demo` (scripts/demo.py) reuses that
# instead of seeding fresh, snapshotting it into a sibling demo/ dir on every launch. The whole
# .data/ tree is gitignored.
E2E_DIR = REPO_ROOT / "frontend" / "e2e"
E2E_DATA_DIR = E2E_DIR / ".data"
# Which subdirectory of .data/ a browser-suite run owns. The backend wipes whichever one it is
# launched with, so `frontend/playwright.config.ts` defaults to the partial one: a run must claim
# main/ before it can touch the database `npm run demo` serves, and only a complete `ci.py
# frontend-e2e` claims it. That keeps a narrowed run, or a hand-typed `playwright test`, from
# replacing a full fixture with one group's data.
E2E_MAIN_DATA_SUBDIR = "main"
E2E_PARTIAL_DATA_SUBDIR = "partial"
E2E_MAIN_DATA_DIR = E2E_DATA_DIR / E2E_MAIN_DATA_SUBDIR
E2E_MAIN_DB = E2E_MAIN_DATA_DIR / "sandbox.db"
DEMO_DATA_DIR = E2E_DATA_DIR / "demo"
FRONTEND_DIST_DIR = REPO_ROOT / "frontend" / "dist"
FRONTEND_LOCAL_DIST_DIR = REPO_ROOT / "frontend" / "dist-local"

# A template is composed from the env-agnostic base layer plus one colocated environment layer.
# templates/base/ never ships alone; environments/<env>/template/ overlays it whole-file.
# The default environment is what the student repo's main branch instantiates.
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
DEPS_VERSION_TS = REPO_ROOT / "backend" / "src" / "build" / "deps-version.ts"

# The e2e submission fixtures are submitted against seasons the backend seeds at the current
# DEPS_VERSION, so their manifests must track the current template version rather than pin one.
E2E_SUBMISSION_FIXTURES_DIR = REPO_ROOT / "frontend" / "e2e" / "fixtures" / "submission"

# The environments package root, under which each environment is its own top-level package.
ENVIRONMENT_PACKAGES_DIR = REPO_ROOT / "environments"
ENVIRONMENTS_IGNORE_FILE = ENVIRONMENT_PACKAGES_DIR / ".envignore"
ENVIRONMENTS_PYPROJECT = ENVIRONMENT_PACKAGES_DIR / "pyproject.toml"


@dataclass(frozen=True)
class TemplateEnvironmentSpec:
    """Static facts needed to generate and compose one student environment template."""

    display_name: str
    inner_package: str
    modules: tuple[str, ...]
    default_action: str = "default_action"
    player_id: str = "player_0"
    # Whether the canonical entry provides immutable overlay data for each recording header.
    has_overlay_static: bool = False
    # Per-environment sandbox modules copied into this template's sandbox/ at compose time,
    # alongside the shared TEMPLATE_BASE_MODULES: destination filename under sandbox/ -> source
    # path under environments/. Empty for environments that need no such module.
    env_sandbox_modules: dict[str, str] = field(default_factory=dict)
    # Composed-template-relative file paths to type-check with pyright after composing, for
    # environments whose sandbox modules carry annotations worth checking in isolation. Empty
    # for environments that register no such check. Every path here must exist in each composed
    # tree, so a rename that loses coverage fails the examples job instead of passing quietly.
    pyright_files: tuple[str, ...] = ()
    # Further paths to type-check where an individual example ships them, for files that belong
    # to one example rather than to the environment layer. Missing ones are skipped.
    pyright_example_files: tuple[str, ...] = ()


# Shared, import-self-contained sandbox helpers generated from the env source into each composed
# template's sandbox/: destination filename under sandbox/ -> source path under the package root.
TEMPLATE_BASE_MODULES = {
    # The dependency-free card codec, resolver, Gymnasium spaces, and static TypedDicts: the pure
    # rules engines pull their encoding from card_utils through shared_modules, card_spaces
    # declares the shared CARD/HAND/TRICK observation shapes, and card_types mirrors those shapes
    # as TypedDicts for annotations. Compose writes them beside each template's own game-specific
    # sandbox/cards.py, which the distinct names keep apart.
    "card_utils.py": "local_play/card_utils.py",
    "card_spaces.py": "local_play/card_spaces.py",
    "shared_modules.py": "local_play/shared_modules.py",
    "semantic_cards.py": "local_play/semantic_cards.py",
    "card_types.py": "local_play/card_types.py",
}

# Environment-root guides are canonical. MkDocs exposes virtual website pages from them, while
# scripts/compose.py renders standalone copies for student templates.
DOCS_DIR = REPO_ROOT / "docs"
ENVIRONMENT_GUIDE_NAME = "environment.md"


def env_environment_guide(env: str) -> Path:
    """Return an environment's editable, canonical student guide."""
    return ENVIRONMENT_PACKAGES_DIR / env / ENVIRONMENT_GUIDE_NAME


def env_template_layer(env: str) -> Path:
    """Return the hand-authored template layer colocated with ``env``'s source package."""
    return ENVIRONMENT_PACKAGES_DIR / env / "template"


def env_examples_dir(env: str) -> Path:
    """Return the directory containing hand-authored examples for ``env``."""
    return ENVIRONMENT_PACKAGES_DIR / env / "examples"
