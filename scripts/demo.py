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
fixture from a fresh frontend-e2e run regardless of any prior result. The existing database is
discarded and the suite is run again, picking up source changes since it was last built.

Sign-in, not a baked identity: the backend embeds Better Auth (Stage 12), so there is no more
mock request header or session/operator allowlist to fabricate a user with. The backend runs with
the exact same loopback auth config as the e2e "main" backend (see frontend/playwright.config.ts):
``AUTH_ALLOW_INSECURE_DEFAULTS=true`` plus a loopback ``PUBLIC_ORIGIN``. That re-syncs the copied
database's bootstrap admin to the published dev defaults on startup, and every persona is reached
the same way a real user would: by signing in at /login. On launch the command prints the
credentials for two example accounts to sign in with:

- The bootstrap admin (``admin@example.com`` / ``admin-dev-password``), so signing in at /login
  shows the full surface including the admin console.
- A fixed ordinary member (the "student" view): the e2e fixture's ``ada-lovelace`` (the glider
  owner, the most data-rich member: a submitted agent, an author rating prompt, watch recordings,
  and competition placements). Signing in as them shows the member experience with real data behind
  every page, and the admin console stays correctly locked. Their Better Auth role is ``user``,
  never promoted to ``admin``.

If the backend reports a stale-schema SQLite error during startup, run
``npm run demo -- --rerun-e2e`` to rebuild the fixture.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess

from _paths import (
    DEMO_DATA_DIR,
    E2E_MAIN_DATA_DIR,
    E2E_MAIN_DB,
    FRONTEND_DIST_DIR,
    REPO_ROOT,
)
from ci import _NPM, _run, job_frontend_e2e

# The bootstrap admin the backend seeds under AUTH_ALLOW_INSECURE_DEFAULTS uses the published
# development defaults (DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD in backend/src/config/config.ts). Must match
# frontend/e2e/support/auth.ts's ADMIN_EMAIL / ADMIN_PASSWORD, which the e2e suite's bootstrap
# admin signs in with as well.
_ADMIN_EMAIL = "admin@example.com"
_ADMIN_PASSWORD = "admin-dev-password"

# ada-lovelace, the ordinary member (the "student" view) whose credentials the demo prints
# alongside the admin's: a fixed e2e fixture account chosen as the most data-rich non-admin so the
# most member-facing features have real content: a submitted agent (My Agents / agent profile), an
# author rating prompt, watch recordings, and competition placements all attach to it (see
# frontend/e2e/support/names.ts). The e2e suite's fixtures create this as a real Better Auth account
# with role `user`, never promoted to `admin`, so it stays an ordinary member here too. Must match
# frontend/e2e/support/auth.ts's `emailFor('ada-lovelace')` and `MEMBER_PASSWORD`.
_MEMBER_EMAIL = "ada-lovelace@e2e.local"
_MEMBER_PASSWORD = "e2e-member-password"


def ensure_e2e_db() -> None:
    """Build the e2e database via the frontend-e2e job when it does not exist yet."""
    if not E2E_MAIN_DB.exists():
        print("e2e main DB missing -> running frontend-e2e to build it", flush=True)
        job_frontend_e2e()
    if not E2E_MAIN_DB.exists():
        raise SystemExit("e2e run did not produce frontend/e2e/.data/main/sandbox.db")


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

    The bundle is identity-agnostic: identity now comes from a real Better Auth sign-in at /login
    rather than a build-time baked user, so nothing about it varies with which account is used.
    """
    _run([_NPM, "run", "build:frontend"])


def prepare_demo_data() -> None:
    """Discard any prior demo data, then snapshot main/ into demo/.

    No backend is writing main/ here (e2e has exited), so the complete data directory is a stable
    snapshot. Copying the whole tree keeps the database together with recordings, submission
    archives, LLM telemetry, and any future backend-managed sidecars.
    """
    if DEMO_DATA_DIR.exists():
        shutil.rmtree(DEMO_DATA_DIR)
    shutil.copytree(E2E_MAIN_DATA_DIR, DEMO_DATA_DIR)


def _print_credentials() -> None:
    """Print both example accounts' credentials prominently before the backend starts serving.

    The demo seeds no identity of its own: the bootstrap admin is re-synced to the published dev
    defaults on every boot (ensureAdminUser), and the ordinary member ada-lovelace rides along in
    the copied e2e fixture database. Both are reached by a real sign-in at /login, and both are
    printed so the demo can be explored from either the admin or the member ("student") side without
    a second launch.

    Recreating the demo database on every launch (see prepare_demo_data) invalidates any Better
    Auth session cookie from a previous run, so a real sign-in through the login page is required
    every time, not just the first.

    """
    print(
        "\n"
        "==========================================================================\n"
        "  Open http://localhost:8080/, go to /login, and sign in with either\n"
        "  example account:\n"
        "\n"
        "    admin: the full surface, including the admin console:\n"
        f"        email:    {_ADMIN_EMAIL}\n"
        f"        password: {_ADMIN_PASSWORD}\n"
        "\n"
        "    student: an ordinary member (ada-lovelace, the data-rich non-admin):\n"
        f"        email:    {_MEMBER_EMAIL}\n"
        f"        password: {_MEMBER_PASSWORD}\n"
        "\n"
        "  This demo database was just (re)created. Any cookie from a previous run\n"
        "  is no longer valid, so a real sign-in is required. If the fixture is\n"
        "  stale or incomplete, run `npm run demo -- --rerun-e2e`.\n"
        "==========================================================================\n",
        flush=True,
    )


def _demo_env() -> dict[str, str]:
    """Backend env for the demo: the same loopback Better Auth config as the e2e "main" backend
    the data was written under (see frontend/playwright.config.ts), widening the idle timeout for
    a usable demo, on port 8080 so a lingering e2e server on 8090 does not clash.

    There is no per-mode allowlist or baked identity left to vary. ``AUTH_ALLOW_INSECURE_DEFAULTS``
    opts into the published development defaults, so the copied database's bootstrap admin re-syncs
    to ``_ADMIN_EMAIL``/``_ADMIN_PASSWORD`` on startup, and every persona (the bootstrap admin or a
    member fixture like ada-lovelace) is reached by signing in for real at /login.
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


def run_backend() -> int:
    """Run the backend against the demo copy."""
    cmd = [_NPM, "run", "start", "--workspace", "@game-sandbox/backend"]
    print(f"$ {' '.join(cmd)}  (PORT=8080 DATA_DIR={DEMO_DATA_DIR})", flush=True)
    proc = subprocess.Popen(cmd, cwd=REPO_ROOT, env=_demo_env())
    try:
        return proc.wait()
    except KeyboardInterrupt:
        return proc.wait()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run the app on the e2e fixture database.")
    parser.add_argument(
        "--rerun-e2e",
        action="store_true",
        help=(
            "Force a fresh frontend-e2e run before starting, rebuilding the fixture database "
            "from scratch even when one already exists. By default an existing e2e database is "
            "reused as-is; with this flag the prior database is discarded and the suite is run "
            "again regardless of any prior result. Use it to recover from stale-schema SQLite "
            "startup errors. Invoke as `npm run demo -- --rerun-e2e`."
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

    build_frontend()
    prepare_demo_data()

    _print_credentials()
    raise SystemExit(run_backend())


if __name__ == "__main__":
    main()
