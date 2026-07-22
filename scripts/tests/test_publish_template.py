"""Publication-time local browser bundle assembly."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import publish_template as publisher  # noqa: E402


def _composed_output(root: Path, name: str) -> Path:
    output = root / name
    web = output / "sandbox" / "web"
    web.mkdir(parents=True)
    (web / "stale.txt").write_text("stale\n", encoding="utf-8")
    return output


def test_publish_builds_once_and_replaces_bundle_in_every_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    bundle = tmp_path / "frontend" / "dist-local"
    assets = bundle / "assets"
    assets.mkdir(parents=True)
    (bundle / "local.html").write_text("<main>stale</main>\n", encoding="utf-8")
    (assets / "stale.js").write_text("console.log('stale')\n", encoding="utf-8")
    outputs = {
        "flappy_bird": _composed_output(tmp_path / "composed", "template-flappy"),
        "hearts": _composed_output(tmp_path / "composed", "template-hearts"),
        "flappy_bird/hello": _composed_output(tmp_path / "composed", "example-hello"),
        "hearts/oracle": _composed_output(tmp_path / "composed", "example-oracle"),
    }
    calls: list[tuple[list[str], Path]] = []

    def fake_run(command: list[str], *, cwd: Path, check: bool) -> None:
        calls.append((command, cwd))
        assert not bundle.exists()
        fresh_assets = bundle / "assets"
        fresh_assets.mkdir(parents=True)
        (bundle / "local.html").write_text("<main>fresh</main>\n", encoding="utf-8")
        (fresh_assets / "fresh.js").write_text("console.log('fresh')\n", encoding="utf-8")

    monkeypatch.setattr(publisher, "FRONTEND_LOCAL_DIST_DIR", bundle)
    monkeypatch.setattr(publisher, "BUILD_DIR", tmp_path / "build")
    monkeypatch.setattr(publisher, "list_envs", lambda: ["flappy_bird", "hearts"])
    monkeypatch.setattr(publisher, "list_examples", lambda: [("flappy_bird", "hello"), ("hearts", "oracle")])
    monkeypatch.setattr(publisher, "compose_template", lambda env: outputs[env])
    monkeypatch.setattr(publisher, "compose_example", lambda env, name: outputs[f"{env}/{name}"])
    monkeypatch.setattr(publisher.subprocess, "run", fake_run)

    publisher.publish(
        version=7,
        sha="abc123",
        target_repo="owner/template",
        token=None,
        dry_run=True,
    )

    assert calls == [
        (
            [
                "npm.cmd" if sys.platform == "win32" else "npm",
                "run",
                "build:local",
                "--workspace",
                "@game-sandbox/frontend",
            ],
            publisher.REPO_ROOT,
        )
    ]
    for output in outputs.values():
        web = output / "sandbox" / "web"
        assert (web / "local.html").read_text(encoding="utf-8") == "<main>fresh</main>\n"
        assert (web / "assets" / "fresh.js").is_file()
        assert not (web / "stale.txt").exists()
        assert not (web / "assets" / "stale.js").exists()

    snapshots = [
        tmp_path / "build" / "publish" / "main",
        tmp_path / "build" / "publish" / "templates" / "flappy_bird",
        tmp_path / "build" / "publish" / "templates" / "hearts",
        tmp_path / "build" / "publish" / "examples" / "flappy_bird" / "hello",
        tmp_path / "build" / "publish" / "examples" / "hearts" / "oracle",
    ]
    for snapshot in snapshots:
        web = snapshot / "sandbox" / "web"
        assert (web / "local.html").read_text(encoding="utf-8") == "<main>fresh</main>\n"
        assert (web / "assets" / "fresh.js").is_file()
        assert not (web / "stale.txt").exists()
        assert not (web / "assets" / "stale.js").exists()

    assert not (bundle / "assets" / "stale.js").exists()


def test_local_frontend_build_requires_local_html(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    bundle = tmp_path / "frontend" / "dist-local"
    bundle.mkdir(parents=True)
    (bundle / "local.html").write_text("<main>stale</main>\n", encoding="utf-8")
    monkeypatch.setattr(publisher, "FRONTEND_LOCAL_DIST_DIR", bundle)
    monkeypatch.setattr(publisher.subprocess, "run", lambda *args, **kwargs: None)

    with pytest.raises(publisher.PublishError, match=r"did not produce .*local\.html"):
        publisher._build_local_frontend()

    assert not bundle.exists()
