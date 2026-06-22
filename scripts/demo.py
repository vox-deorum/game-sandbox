"""Start the app on the database the frontend-e2e job builds: ``npm run demo``.

The normal ``npm start`` seeds only empty "Playground" seasons. The frontend-e2e job, by
contrast, drives real sessions, submissions, and season releases against its "main" backend,
leaving a rich SQLite database under ``frontend/e2e/.data/main/``. This script reuses that
database instead of seeding anything: it snapshots ``main/`` into a sibling ``demo/`` dir and
starts the backend against the copy. If the e2e database has never been built, it runs the
frontend-e2e job first to produce it.

A fresh copy is taken on every launch, so each demo starts from a clean snapshot of the latest
e2e data and demo play never mutates the ``main/`` fixture that local e2e runs reuse.

Schema drift: the backend keeps a single flat migration that is *not* re-run against a database
that already recorded it (see backend/src/storage/migrations.ts). So if the schema has advanced
since the e2e database was built, the reused copy is stale and the backend throws a SQLite
"no such column"/"no such table" error during startup, before it begins listening. When that
happens we rebuild the e2e database from scratch (the only way to pick up a schema change is to
recreate it) and start once more.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

from _paths import (
    DEMO_DATA_DIR,
    E2E_MAIN_DATA_DIR,
    E2E_MAIN_DB,
    E2E_RESTRICTED_DATA_DIR,
    FRONTEND_DIST_DIR,
    REPO_ROOT,
)
from ci import _NPM, _run, job_frontend_e2e

# The backend logs this once startup succeeds and it is accepting connections.
_LISTENING_MARKER = "backend listening on"
# A reused database with a stale schema surfaces as one of these SQLite errors during the
# startup queries (seedOpenSeasons, run reconciliation, submission re-enqueue). Matched only
# before the listening marker, so a healthy server's later logs cannot trip the rebuild.
_SCHEMA_ERROR_MARKERS = (
    "no such column",
    "no such table",
    "has no column named",
    "no such index",
)


def ensure_e2e_db() -> None:
    """Build the e2e database via the frontend-e2e job when it does not exist yet."""
    if not E2E_MAIN_DB.exists():
        print("e2e main DB missing -> running frontend-e2e to build it", flush=True)
        job_frontend_e2e()
    if not E2E_MAIN_DB.exists():
        raise SystemExit("e2e run did not produce frontend/e2e/.data/main/sandbox.db")


def rebuild_e2e_db() -> None:
    """Recreate the e2e database from scratch with the current schema.

    Deletes both e2e backends' data dirs first: the flat migration only builds the latest schema
    on a *fresh* database, and a stale restricted DB would fail the e2e run the same way. The next
    frontend-e2e run then rebuilds them with the current schema and repopulates the data.
    """
    for data_dir in (E2E_MAIN_DATA_DIR, E2E_RESTRICTED_DATA_DIR):
        if data_dir.exists():
            shutil.rmtree(data_dir)
    job_frontend_e2e()
    if not E2E_MAIN_DB.exists():
        raise SystemExit("e2e rebuild did not produce frontend/e2e/.data/main/sandbox.db")


def build_frontend() -> None:
    """Rebuild the SPA bundle the backend serves from FRONTEND_DIST.

    Always rebuilt, not reused: there is no dev watcher here, so a cached dist would silently
    serve a stale frontend and hide local source edits. The backend itself runs from TypeScript
    source (``tsx src/main.ts``), so it needs no build step and always reflects current code.
    """
    _run([_NPM, "run", "build:frontend"])


def prepare_demo_data() -> None:
    """Discard any prior demo data, then snapshot main/ into demo/.

    No backend is writing main/ here (e2e has exited), so the WAL is quiescent; copy the db
    together with its -wal/-shm siblings so SQLite replays a consistent state on open.
    """
    if DEMO_DATA_DIR.exists():
        shutil.rmtree(DEMO_DATA_DIR)
    DEMO_DATA_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("sandbox.db", "sandbox.db-wal", "sandbox.db-shm"):
        src = E2E_MAIN_DATA_DIR / name
        if src.exists():
            shutil.copy2(src, DEMO_DATA_DIR / name)
    recordings = E2E_MAIN_DATA_DIR / "recordings"
    if recordings.exists():
        shutil.copytree(recordings, DEMO_DATA_DIR / "recordings", dirs_exist_ok=True)


def _demo_env() -> dict[str, str]:
    """Backend env for the demo: mirrors the e2e "main" backend the data was written under
    (dev-user allowlist, local submissions on), widening the idle timeout and operator access
    for a usable demo, on port 8080 so a lingering e2e server on 8090 does not clash."""
    env = os.environ.copy()
    env.update(
        {
            "DATA_DIR": str(DEMO_DATA_DIR),
            "FRONTEND_DIST": str(FRONTEND_DIST_DIR),
            "SESSION_ALLOWLIST": "dev-user",
            "OPERATOR_ALLOWLIST": "dev-user",
            "ALLOW_LOCAL_SUBMISSIONS": "true",
            "SESSION_IDLE_TIMEOUT_MS": "600000",
            "PORT": "8080",
        }
    )
    return env


def run_backend() -> tuple[int, bool]:
    """Run the backend against the demo copy, streaming its output.

    Returns ``(returncode, schema_drift)`` where ``schema_drift`` is True only when the process
    exited having logged a stale-schema SQLite error before it started listening — the signal to
    rebuild the e2e database and retry.
    """
    cmd = [_NPM, "run", "start", "--workspace", "@game-sandbox/backend"]
    print(f"$ {' '.join(cmd)}  (PORT=8080 DATA_DIR={DEMO_DATA_DIR})", flush=True)
    # subprocess.Popen (not _run): we tee the child's output to watch startup for the schema
    # signature while still showing the live server log. stderr is merged so console.error is seen.
    proc = subprocess.Popen(
        cmd,
        cwd=REPO_ROOT,
        env=_demo_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    listening = False
    schema_error = False
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            lowered = line.lower()
            if _LISTENING_MARKER in lowered:
                listening = True
            elif not listening and any(m in lowered for m in _SCHEMA_ERROR_MARKERS):
                schema_error = True
    except KeyboardInterrupt:
        # Ctrl-C reaches the child too; let it shut down gracefully and report its own code.
        pass
    returncode = proc.wait()
    return returncode, (schema_error and not listening)


def main() -> None:
    ensure_e2e_db()
    build_frontend()
    prepare_demo_data()

    returncode, schema_drift = run_backend()
    if schema_drift:
        print(
            "demo backend hit a stale-schema SQLite error -> rebuilding the e2e DB from scratch",
            flush=True,
        )
        # The frontend bundle is independent of the database, so the build above still stands;
        # only the e2e data needs recreating before we retry.
        rebuild_e2e_db()
        prepare_demo_data()
        returncode, _ = run_backend()

    raise SystemExit(returncode)


if __name__ == "__main__":
    main()
