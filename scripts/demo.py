"""Start the app on the database the frontend-e2e job builds: ``npm run demo``.

The normal ``npm start`` seeds only empty "Playground" seasons. The frontend-e2e job, by
contrast, drives real sessions, submissions, and season releases against its "main" backend,
leaving a rich SQLite database under ``frontend/e2e/.data/main/``. This script reuses that
database instead of seeding anything: it snapshots ``main/`` into a sibling ``demo/`` dir and
starts the backend against the copy. If the e2e database has never been built, it runs the
frontend-e2e job first to produce it.

A fresh copy is taken on every launch, so each demo starts from a clean snapshot of the latest
e2e data and demo play never mutates the ``main/`` fixture that local e2e runs reuse.

Forcing a rerun: the e2e job runs only when the database is missing, so a successful run is
reused indefinitely. Pass ``--rerun-e2e`` (``npm run demo -- --rerun-e2e``) to rebuild the
fixture from a fresh frontend-e2e run regardless of any prior result — the existing database is
discarded and the suite is run again, picking up source changes since it was last built.

Sign-in, not a baked identity: the backend embeds Better Auth (Stage 12), so there is no more
mock request header or session/operator allowlist to fabricate a user with. Both launch modes run
the backend with the exact same loopback auth config as the e2e "main" backend (see
frontend/playwright.config.ts): ``AUTH_ALLOW_INSECURE_DEFAULTS=true`` plus a loopback
``PUBLIC_ORIGIN``. That re-syncs the copied database's bootstrap admin to the published dev
defaults on startup, and every persona is reached the same way a real user would: by signing in
at /login. The two modes differ only in which persona's credentials the command prints:

- ``npm run demo`` prints the bootstrap admin's credentials (``admin@example.com`` /
  ``admin-dev-password``), so signing in at /login shows the full surface including the admin
  console.
- ``npm run demo:user`` (``--user``) prints a fixed ordinary member's credentials instead: the e2e
  fixture's ``ada-lovelace`` (the glider owner — the most data-rich member: a submitted agent, an
  author rating prompt, watch recordings, and competition placements). Signing in as them shows
  the member experience with real data behind every page, and the admin console stays correctly
  locked — their Better Auth role is ``user``, never promoted to ``admin``.

Schema drift: the backend keeps a single flat migration that is *not* re-run against a database
that already recorded it (see backend/src/storage/migrations.ts). So if the schema has advanced
since the e2e database was built, the reused copy is stale and the backend throws a SQLite
"no such column"/"no such table" error during startup, before it begins listening. When that
happens we rebuild the e2e database from scratch (the only way to pick up a schema change is to
recreate it) and start once more.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import subprocess
import sys

from _paths import (
    DEMO_DATA_DIR,
    E2E_MAIN_DATA_DIR,
    E2E_MAIN_DB,
    FRONTEND_DIST_DIR,
    REPO_ROOT,
)
from ci import _NPM, _run, job_frontend_e2e

# The bootstrap admin the backend seeds under AUTH_ALLOW_INSECURE_DEFAULTS — the published
# development defaults (DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD in backend/src/config.ts). Must match
# frontend/e2e/support/auth.ts's ADMIN_EMAIL / ADMIN_PASSWORD, which the e2e suite's bootstrap
# admin signs in with as well.
_ADMIN_EMAIL = "admin@example.com"
_ADMIN_PASSWORD = "admin-dev-password"

# ada-lovelace, the ordinary member `demo:user` signs in as: a fixed e2e fixture account chosen as
# the most data-rich non-admin so the most member-facing features have real content — a submitted
# agent (My Agents / agent profile), an author rating prompt, watch recordings, and competition
# placements all attach to it (see frontend/e2e/support/names.ts). The e2e suite's fixtures create
# this as a real Better Auth account with role `user`, never promoted to `admin`, so it stays an
# ordinary member here too. Must match frontend/e2e/support/auth.ts's `emailFor('ada-lovelace')`
# and `MEMBER_PASSWORD`.
_MEMBER_EMAIL = "ada-lovelace@e2e.local"
_MEMBER_PASSWORD = "e2e-member-password"

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


def _member_account_present() -> bool:
    """Whether the e2e database holds the ``demo:user`` member account.

    The bootstrap admin is reseeded on every backend boot (ensureAdminUser), so the default demo is
    always reachable, but ``ada-lovelace`` exists only if the frontend-e2e run that built the database
    included the spec that creates her (leaderboards-admin.spec.ts). A partial run — a single unrelated
    spec left behind under ``.data/main/`` — leaves a schema-valid database with no member to sign in
    as, which ``run_backend``'s stale-schema retry cannot detect, so ``demo:user`` would print her
    credentials and then fail the real /login for no visible reason. Probe the Better Auth ``user``
    table up front so that case fails fast with an explanation instead.
    """
    if not E2E_MAIN_DB.exists():
        return False
    try:
        with sqlite3.connect(f"file:{E2E_MAIN_DB}?mode=ro", uri=True) as conn:
            row = conn.execute("SELECT 1 FROM user WHERE email = ? LIMIT 1", (_MEMBER_EMAIL,)).fetchone()
        return row is not None
    except sqlite3.Error:
        # No `user` table (a corrupt or pre-Better-Auth database) counts as the member being absent.
        return False


def rebuild_e2e_db() -> None:
    """Recreate the e2e database from scratch with the current schema.

    Deletes the e2e main data dir first: the flat migration only builds the latest schema on a
    *fresh* database. The next frontend-e2e run then rebuilds it with the current schema and
    repopulates the data, including the Better Auth accounts (the bootstrap admin and the member
    fixtures such as ada-lovelace) the demo signs in as.
    """
    if E2E_MAIN_DATA_DIR.exists():
        shutil.rmtree(E2E_MAIN_DATA_DIR)
    job_frontend_e2e()
    if not E2E_MAIN_DB.exists():
        raise SystemExit("e2e rebuild did not produce frontend/e2e/.data/main/sandbox.db")


def build_frontend() -> None:
    """Rebuild the SPA bundle the backend serves from FRONTEND_DIST.

    Always rebuilt, not reused: there is no dev watcher here, so a cached dist would silently
    serve a stale frontend and hide local source edits. The backend itself runs from TypeScript
    source (``tsx src/main.ts``), so it needs no build step and always reflects current code.

    Both launch modes build the identical bundle: identity now comes from a real Better Auth
    sign-in at /login rather than a build-time baked user, so there is nothing left to vary
    per mode here.
    """
    _run([_NPM, "run", "build:frontend"])


def prepare_demo_data() -> None:
    """Discard any prior demo data, then snapshot main/ into demo/.

    No backend is writing main/ here (e2e has exited), so the WAL is quiescent; copy the db
    together with its -wal/-shm siblings so SQLite replays a consistent state on open. The Better
    Auth tables (accounts, sessions, etc.) live in this same sandbox.db, so the copy already
    carries them — no separate step is needed to bring the personas along.
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


def _credentials(acting_user: bool) -> tuple[str, str]:
    """The (email, password) pair to sign in with: the bootstrap admin by default, or Ada's
    ordinary-member account when ``acting_user`` is True (``demo:user``)."""
    if acting_user:
        return _MEMBER_EMAIL, _MEMBER_PASSWORD
    return _ADMIN_EMAIL, _ADMIN_PASSWORD


def _print_credentials(acting_user: bool) -> None:
    """Print the persona's credentials prominently before the backend starts serving.

    Recreating the demo database on every launch (see prepare_demo_data) invalidates any Better
    Auth session cookie from a previous run — the session row it pointed at is gone — so a real
    sign-in through the login page is required every time, not just the first.
    """
    email, password = _credentials(acting_user)
    persona = "the ordinary member ada-lovelace" if acting_user else "the bootstrap admin"
    print(
        "\n"
        "==========================================================================\n"
        f"  Open http://localhost:8080/, go to /login, and sign in as {persona}:\n"
        f"      email:    {email}\n"
        f"      password: {password}\n"
        "  This demo database was just (re)created, so any cookie from a previous\n"
        "  run is no longer valid — a real sign-in is required.\n"
        "==========================================================================\n",
        flush=True,
    )


def _demo_env() -> dict[str, str]:
    """Backend env for the demo: the same loopback Better Auth config as the e2e "main" backend
    the data was written under (see frontend/playwright.config.ts), widening the idle timeout for
    a usable demo, on port 8080 so a lingering e2e server on 8090 does not clash.

    Both launch modes run this exact env — there is no per-mode allowlist or baked identity left
    to vary. ``AUTH_ALLOW_INSECURE_DEFAULTS`` opts into the published development defaults, so the
    copied database's bootstrap admin re-syncs to ``_ADMIN_EMAIL``/``_ADMIN_PASSWORD`` on startup,
    and every persona (the bootstrap admin or a member fixture like ada-lovelace) is reached by
    signing in for real at /login.
    """
    env = os.environ.copy()
    env.update(
        {
            "DATA_DIR": str(DEMO_DATA_DIR),
            "FRONTEND_DIST": str(FRONTEND_DIST_DIR),
            "AUTH_ALLOW_INSECURE_DEFAULTS": "true",
            "PUBLIC_ORIGIN": "http://localhost:8080",
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


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run the app on the e2e fixture database.")
    parser.add_argument(
        "--user",
        action="store_true",
        help=(
            "Sign in as the ordinary member ada-lovelace (the e2e fixture's most data-rich "
            "non-admin) instead of the bootstrap admin, via the real login page. Wired to "
            "`npm run demo:user`."
        ),
    )
    parser.add_argument(
        "--rerun-e2e",
        action="store_true",
        help=(
            "Force a fresh frontend-e2e run before starting, rebuilding the fixture database "
            "from scratch even when one already exists. By default an existing e2e database is "
            "reused as-is; with this flag the prior database is discarded and the suite is run "
            "again regardless of any prior result. Invoke as `npm run demo -- --rerun-e2e`."
        ),
    )
    args = parser.parse_args(argv)

    if args.rerun_e2e:
        print(
            "--rerun-e2e -> discarding any prior e2e database and rebuilding it from a fresh run",
            flush=True,
        )
        rebuild_e2e_db()
    else:
        ensure_e2e_db()

    # `demo:user` signs in as a persisted fixture account, so a reused-but-incomplete database (built
    # by a single spec that never created ada-lovelace) would fail the sign-in with no visible cause.
    # Fail fast with the fix instead. The default admin demo needs no such check — the admin is
    # reseeded on every boot regardless of which specs ran.
    if args.user and not _member_account_present():
        raise SystemExit(
            f"demo:user signs in as {_MEMBER_EMAIL}, but the reused e2e database at {E2E_MAIN_DB} "
            f"has no such account — it was likely built by a partial run without "
            f"leaderboards-admin.spec.ts. Rebuild it with `npm run demo:user -- --rerun-e2e`, which "
            f"runs the full frontend-e2e suite and recreates the member fixtures."
        )

    build_frontend()
    prepare_demo_data()

    _print_credentials(args.user)
    returncode, schema_drift = run_backend()
    if schema_drift:
        print(
            "demo backend hit a stale-schema SQLite error -> rebuilding the e2e DB from scratch",
            flush=True,
        )
        # The frontend bundle is independent of the database (identity comes from a real sign-in,
        # not anything baked in), so the build above still stands; only the e2e data needs
        # recreating.
        rebuild_e2e_db()
        prepare_demo_data()
        _print_credentials(args.user)
        returncode, _ = run_backend()

    raise SystemExit(returncode)


if __name__ == "__main__":
    main()
