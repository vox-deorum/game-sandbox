"""Publish the template and composed examples to the student-facing repository.

Invoked by the manually dispatched ``template-publish.yml`` workflow (``workflow_dispatch``
with a ``version`` input N), which calls this script with ``--tag template-v<N>``; it is
equally runnable locally with the same flag. The ``template-v<N>`` tag is *not* the trigger
— the workflow stamps it as its last step, after the student repo is fully updated, so a
run that fails partway leaves no dangling release tag to clean up before retrying. The
workflow is a thin wrapper around this one script and ``scripts/compose.py``, so local
development, CI verification, and publishing all exercise one code path and a student's
clone is byte-identical to what CI tested.

The student repo (``vox-deorum/game-agent-template``) is a single repository whose branches
carry the per-environment templates and examples. For tag ``template-v<N>``:

1. Composes the default-environment template and every example from the current ``templates/``.
2. Publishes the *default* environment's composed template to ``main`` (so "Use this
   template" instantiates it), committed as ``Template v<N> from game-sandbox@<sha>`` with a
   mirrored ``v<N>`` tag.
3. Force-pushes each environment's composed template to an orphan branch ``templates/<env>``.
4. Force-pushes each composed example to an orphan branch ``examples/<env>/<name>``.

``--dry-run`` does everything except the network pushes (it still composes and assembles
the snapshots under ``build/publish/``), which is how the tag-to-publish path is rehearsed
locally without touching the student repository.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from _paths import BUILD_DIR, DEFAULT_TEMPLATE_ENV, FRONTEND_LOCAL_DIST_DIR, REPO_ROOT
from compose import compose_example, compose_template, list_envs, list_examples

DEFAULT_TARGET_REPO = "vox-deorum/game-agent-template"
_TAG_PATTERN = re.compile(r"^(?:refs/tags/)?template-v(\d+)$")


class PublishError(Exception):
    """Raised when publishing cannot proceed (bad tag, missing token, git failure)."""


def resolve_version(explicit: str | None) -> int:
    """Resolve the integer N from an explicit --tag, else from GITHUB_REF."""
    candidate = explicit or os.environ.get("GITHUB_REF", "")
    match = _TAG_PATTERN.match(candidate)
    if not match:
        raise PublishError(
            f"expected a template-v<N> tag, got {candidate!r}. Pass --tag template-v<N> "
            f"or set GITHUB_REF to one."
        )
    return int(match.group(1))


def current_sha() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def _git(args: list[str], cwd: Path) -> None:
    print(f"$ git {' '.join(args)} (in {cwd})", flush=True)
    subprocess.run(["git", *args], cwd=cwd, check=True)


def _remote_url(target_repo: str, token: str | None) -> str:
    if token:
        return f"https://x-access-token:{token}@github.com/{target_repo}.git"
    return f"https://github.com/{target_repo}.git"


def _build_local_frontend() -> Path:
    """Build and validate the local browser bundle used only in published snapshots."""
    if FRONTEND_LOCAL_DIST_DIR.exists():
        if FRONTEND_LOCAL_DIST_DIR.is_dir():
            shutil.rmtree(FRONTEND_LOCAL_DIST_DIR)
        else:
            FRONTEND_LOCAL_DIST_DIR.unlink()
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    subprocess.run(
        [npm, "run", "build:local", "--workspace", "@game-sandbox/frontend"],
        cwd=REPO_ROOT,
        check=True,
    )
    local_html = FRONTEND_LOCAL_DIST_DIR / "local.html"
    if not local_html.is_file():
        raise PublishError(f"local frontend build did not produce {local_html}")
    return FRONTEND_LOCAL_DIST_DIR


def _inject_local_frontend(bundle: Path, destinations: list[Path]) -> None:
    """Replace each composed output's browser bundle with the validated publish artifact."""
    for output in destinations:
        destination = output / "sandbox" / "web"
        if destination.exists():
            shutil.rmtree(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(bundle, destination)


def _assemble_snapshot(src: Path, dest: Path) -> None:
    """Replace dest's working content with a fresh copy of src (keeping any .git)."""
    if dest.exists():
        for child in dest.iterdir():
            if child.name == ".git":
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    else:
        dest.mkdir(parents=True)
    shutil.copytree(src, dest, dirs_exist_ok=True)


def _drop_venv(snapshot_dir: Path) -> None:
    """Remove a per-compose .venv if a local compose left one behind in the snapshot."""
    venv = snapshot_dir / ".venv"
    if venv.exists():
        shutil.rmtree(venv)


def _prepare_snapshot(src: Path, dest: Path) -> None:
    """Assemble a clean, runnable publish snapshot at ``dest``."""
    dest.mkdir(parents=True, exist_ok=True)
    _assemble_snapshot(src, dest)
    _drop_venv(dest)


def _publish_orphan_snapshot(dest: Path, *, branch: str, message: str, remote: str) -> None:
    """Force-push an already prepared snapshot as a fresh orphan ``branch``."""
    _git(["init", "-q"], cwd=dest)
    _git(["checkout", "-q", "--orphan", branch], cwd=dest)
    _git(["add", "-A"], cwd=dest)
    _git(["commit", "-q", "-m", message], cwd=dest)
    _git(["push", "-f", remote, f"HEAD:{branch}"], cwd=dest)


def publish(
    *,
    version: int,
    sha: str,
    target_repo: str,
    token: str | None,
    dry_run: bool,
) -> None:
    envs = list_envs()
    if DEFAULT_TEMPLATE_ENV not in envs:
        raise PublishError(
            f"default environment {DEFAULT_TEMPLATE_ENV!r} has no template layer; found {envs or '(none)'}."
        )
    local_bundle = _build_local_frontend()
    templates = {env: compose_template(env) for env in envs}
    examples = list_examples()
    composed = {(env, name): compose_example(env, name) for env, name in examples}
    _inject_local_frontend(local_bundle, [*templates.values(), *composed.values()])
    print(f"composed {len(templates)} template(s): {', '.join(templates) or '(none)'}")
    print(f"composed {len(composed)} example(s): {', '.join(f'{e}/{n}' for e, n in composed) or '(none)'}")

    publish_root = BUILD_DIR / "publish"
    if publish_root.exists():
        shutil.rmtree(publish_root)
    publish_root.mkdir(parents=True)

    remote = _remote_url(target_repo, token)
    commit_message = f"Template v{version} from game-sandbox@{sha}"

    # 1. The default environment's composed template -> main branch, with a mirrored v<N> tag.
    #    "Use this template" instantiates main, so main must be a runnable composed kit, not
    #    the raw templates/ tree (which no longer runs on its own).
    main_dir = publish_root / "main"
    _prepare_snapshot(templates[DEFAULT_TEMPLATE_ENV], main_dir)
    template_snapshots = {env: publish_root / "templates" / env for env in templates}
    example_snapshots = {(env, name): publish_root / "examples" / env / name for env, name in composed}
    for env, out_dir in templates.items():
        _prepare_snapshot(out_dir, template_snapshots[env])
    for key, out_dir in composed.items():
        _prepare_snapshot(out_dir, example_snapshots[key])
    print(f"prepared {DEFAULT_TEMPLATE_ENV} template snapshot for main: {commit_message!r}, tag v{version}")

    if dry_run:
        print(
            f"[dry-run] would commit the {DEFAULT_TEMPLATE_ENV} template to main and push tag "
            f"v{version} to {target_repo}"
        )
        for env in templates:
            print(f"[dry-run] would force-push template {env!r} to branch templates/{env}")
        for env, name in composed:
            print(f"[dry-run] would force-push example to branch examples/{env}/{name}")
        print("[dry-run] no network operations performed")
        return

    if not token:
        raise PublishError("TEMPLATE_REPO_TOKEN is required for a real publish (not --dry-run)")

    _git(["init", "-q"], cwd=main_dir)
    _git(["checkout", "-q", "-B", "main"], cwd=main_dir)
    _git(["add", "-A"], cwd=main_dir)
    _git(["commit", "-q", "-m", commit_message], cwd=main_dir)
    _git(["tag", "-f", f"v{version}"], cwd=main_dir)
    _git(["push", "-f", remote, "main"], cwd=main_dir)
    _git(["push", "-f", remote, f"v{version}"], cwd=main_dir)

    # 2. Each environment's composed template -> its own orphan snapshot branch.
    for env in templates:
        _publish_orphan_snapshot(
            template_snapshots[env],
            branch=f"templates/{env}",
            message=f"{commit_message} (template: {env})",
            remote=remote,
        )

    # 3. Each composed example -> its own orphan snapshot branch.
    for env, name in composed:
        _publish_orphan_snapshot(
            example_snapshots[(env, name)],
            branch=f"examples/{env}/{name}",
            message=f"{commit_message} (example: {env}/{name})",
            remote=remote,
        )

    print(
        f"published template v{version}: {len(templates)} template branch(es) and "
        f"{len(composed)} example branch(es) to {target_repo}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Publish the template and examples.")
    parser.add_argument("--tag", help="template-v<N> tag string; defaults to $GITHUB_REF")
    parser.add_argument("--target-repo", default=DEFAULT_TARGET_REPO)
    parser.add_argument("--dry-run", action="store_true", help="do everything except the network pushes")
    args = parser.parse_args(argv)

    try:
        version = resolve_version(args.tag)
        publish(
            version=version,
            sha=current_sha(),
            target_repo=args.target_repo,
            token=os.environ.get("TEMPLATE_REPO_TOKEN"),
            dry_run=args.dry_run,
        )
    except PublishError as error:
        print(f"publish failed: {error}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        print(f"publish failed: git exited {error.returncode}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
