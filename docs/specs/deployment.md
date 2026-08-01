# Deployment

The whole app is one Node process: it serves the API, the WebSocket relay, and the built frontend, and it launches session containers through the execution driver defined in [Execution](execution.md). A deployment is that process plus a Docker daemon it can reach.

The process runs in one of two modes:

| Mode | Where the process runs | Supported platforms |
| --- | --- | --- |
| Host process | Directly on the machine, beside the daemon | Anywhere Docker runs, including Docker Desktop on Windows and macOS |
| Containerized | Inside a container built from the repo-root `Dockerfile`, launched by the repo-root `compose.yaml` | A Linux daemon whose filesystem the deployment addresses by host path: a Linux host, or Docker Engine inside WSL2 |

Both modes run the same code with the same configuration surface. Containerized mode adds no capability; it packages the existing process so a deployment becomes one `docker compose up`.

## Containerized mode

The app container mounts the daemon socket and launches session containers as siblings on the same daemon. Nothing is nested: there is one daemon, and the app is one more container on it.

Containerized mode follows four rules:

- **One data path on both sides.** Session containers bind-mount the recordings directory, and the daemon resolves a bind path against its own host filesystem, never against the requesting container. The data directory therefore sits at the identical absolute path on the host and inside the app container, and `compose.yaml` mounts it that way from a single `DATA_DIR` value.
- **Two published ports.** The site port and the internal LLM proxy port. Each LLM-enabled session reaches the proxy through a relay that targets the daemon's host, so the proxy port must be reachable there. [Execution](execution.md#live-sessions) defines the session-side network path.
- **One backend per daemon.** At startup the backend reaps leftover containers from a previous run, telling a previous incarnation of itself from a live peer by process id. Process ids are namespace-local, so that distinction only works across host processes: host-process backends may share a daemon safely, while a containerized backend must be its daemon's only backend.
- **A single-tenant machine.** The mounted daemon socket grants full control of the daemon, which is root-equivalent on the host. The machine hosting a containerized deployment runs nothing that must be protected from this app.

Docker Desktop on Windows and macOS runs containers inside a hidden VM whose filesystem is not the host's, which breaks the one-data-path rule. Those platforms use host-process mode.

Setup steps live in the contributor guide: [Run the app in Docker](../contributors/setup/docker.md).
