# Data folders

This guide locates backend state, test fixtures, demo data, and generated outputs. A normal checkout stores backend state in `backend/data/`, because `DATA_DIR` defaults to that repository-relative path.

## Find the active runtime directory

Check `DATA_DIR` in the backend process environment first, then the repository-root `.env`, then `.env.default`.

The setup wizard prints the selected data directory when it finishes. Relative values are resolved from the repository root.

## Backend runtime data

The active `DATA_DIR` contains:

```text
<DATA_DIR>/
  sandbox.db
  recordings/<id>/recording.jsonl
  submissions/<id>.tar.gz
  llm/<scope>.sqlite
  llm/development/<season>.sqlite
```

`sandbox.db` holds backend state. SQLite may create `-wal` and `-shm` sibling files while a database is open. Recordings are retention-managed. Official live-session and workflow telemetry is stored in `llm/<scope>.sqlite` and is deleted after the last referencing recording is deleted. Development telemetry is stored in `llm/development/<season>.sqlite` and has no automatic cleanup. Submission snapshots rebuild and download submissions; a forced `deps_version` change that deletes a season's submissions also removes their snapshots.

On a host deployment, runtime data is at the configured `DATA_DIR`. The setup and Compose default is `/srv/game-sandbox/data`, at the identical absolute host and Compose `app` container path; another configured path is allowed when it meets that requirement. Session containers receive only `<DATA_DIR>/recordings` at `/recordings`. [Run the app in Docker](../setup/docker.md) explains the topology.

## Test and demo data

Browser e2e data lives in `frontend/e2e/.data/`.

| Directory | Lifecycle |
| --- | --- |
| `partial/` | Default for direct Playwright and narrowed helper runs. The selected directory is deleted before the backend starts. |
| `main/` | Data directory used and rebuilt by a bare unrestricted `uv run python scripts/ci.py frontend-e2e`; the demo source fixture. |
| `demo/` | Recreated from `main/` for each `npm run demo` launch. |

See [Browser end-to-end tests](../testing/browser-e2e.md) for the rationale and commands.

## Other local storage

Compose keeps its Git-ignored `.tls/` directory at the repository root and mounts it at `/tls` in the proxy. It contains the current certificate pair and, after renewal, an optional previous pair. Docker images are stored by the Docker daemon, not in `DATA_DIR`. A session container's `/tmp` is a `tmpfs` limited by `SANDBOX_SCRATCH_MB` and disappears with the container. Local play uses the operating system temporary directory and its scratch disappears after the command.

## Generated folders

These Git-ignored outputs are not `DATA_DIR`:

| Folder | Produced by |
| --- | --- |
| `build/templates/`, `build/examples/` | Template and example composition |
| `build/publish/` | Publish dry run and publication staging |
| `frontend/dist/`, `frontend/dist-local/` | Browser and local-export builds |
| `site/` | Documentation build |
| `frontend/test-results/`, `frontend/playwright-report/`, `frontend/blob-report/` | Frontend test results and reports |
