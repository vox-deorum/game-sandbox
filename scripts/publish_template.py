"""Publish the template and composed examples to the student-facing repository.

Triggered by a pushed ``template-v<N>`` tag (see .github/workflows/template-publish.yml),
but runnable locally. The workflow is a thin wrapper around this one script and
``scripts/compose_example.py``, so local development, CI verification, and publishing all
exercise one code path and a student's clone is byte-identical to what CI tested.

What it does for tag ``template-v<N>``:

1. Composes every example from the current ``templates/``.
2. Publishes ``templates/**`` to the student repo's ``main`` branch, committed as
   ``Template v<N> from game-sandbox@<sha>`` with a mirrored ``v<N>`` tag.
3. Force-pushes each composed example to an orphan branch ``examples/<name>``.

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

from _paths import BUILD_DIR, REPO_ROOT, TEMPLATES_DIR
from compose_example import compose, list_examples

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
            f"or run from a tag push."
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


def publish(
    *,
    version: int,
    sha: str,
    target_repo: str,
    token: str | None,
    dry_run: bool,
) -> None:
    examples = list_examples()
    composed = {name: compose(name) for name in examples}
    print(f"composed {len(composed)} example(s): {', '.join(composed) or '(none)'}")

    publish_root = BUILD_DIR / "publish"
    if publish_root.exists():
        shutil.rmtree(publish_root)
    publish_root.mkdir(parents=True)

    remote = _remote_url(target_repo, token)
    commit_message = f"Template v{version} from game-sandbox@{sha}"

    # 1. The template -> main branch, with a mirrored v<N> tag.
    main_dir = publish_root / "main"
    main_dir.mkdir()
    _assemble_snapshot(TEMPLATES_DIR, main_dir)
    print(f"prepared template snapshot for main: {commit_message!r}, tag v{version}")

    if dry_run:
        print(
            f"[dry-run] would commit the template to main and push tag v{version} to {target_repo}"
        )
        for name in composed:
            print(
                f"[dry-run] would force-push example {name!r} to branch examples/{name} "
                f"on {target_repo}"
            )
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

    # 2. Each composed example -> its own orphan snapshot branch.
    for name, out_dir in composed.items():
        branch = f"examples/{name}"
        ex_dir = publish_root / "examples" / name
        ex_dir.mkdir(parents=True)
        _assemble_snapshot(out_dir, ex_dir)
        # Drop the per-example venv if a local compose left one behind.
        venv = ex_dir / ".venv"
        if venv.exists():
            shutil.rmtree(venv)
        _git(["init", "-q"], cwd=ex_dir)
        _git(["checkout", "-q", "--orphan", branch], cwd=ex_dir)
        _git(["add", "-A"], cwd=ex_dir)
        _git(["commit", "-q", "-m", f"{commit_message} (example: {name})"], cwd=ex_dir)
        _git(["push", "-f", remote, f"HEAD:{branch}"], cwd=ex_dir)

    print(f"published template v{version} and {len(composed)} example(s) to {target_repo}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Publish the template and examples.")
    parser.add_argument("--tag", help="template-v<N> tag; defaults to $GITHUB_REF")
    parser.add_argument("--target-repo", default=DEFAULT_TARGET_REPO)
    parser.add_argument(
        "--dry-run", action="store_true", help="do everything except the network pushes"
    )
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
