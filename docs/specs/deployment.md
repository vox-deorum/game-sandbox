# Deployment

The whole app is one Node process: it serves the API, the WebSocket relay, and the built frontend, and it launches session containers through the execution driver defined in [Execution](execution.md). A host-process deployment is that process plus a Docker daemon it can reach. A containerized deployment also includes the nginx TLS origin described below.

The process runs in one of two modes:

| Mode | Where the process runs | Supported platforms |
| --- | --- | --- |
| Host process | Directly on the machine, beside the daemon | Anywhere Docker runs, including Docker Desktop on Windows and macOS |
| Containerized | Inside a container built from the repo-root `Dockerfile`, behind an nginx container launched by the repo-root `compose.yaml` | A Linux daemon whose filesystem the deployment addresses by host path: a Linux host, or Docker Engine inside WSL2 |

Both modes run the same application code. Containerized mode packages the process behind a managed TLS boundary so a deployment becomes one `docker compose up`.

## Containerized mode

The app container mounts the daemon socket and launches session containers as siblings on the same daemon. Nothing is nested: there is one daemon, and the app is one more container on it. nginx is the only service that publishes site ports.

Containerized mode follows four rules:

- **One data path on both sides.** Session containers bind-mount the recordings directory, and the daemon resolves a bind path against its own host filesystem, never against the requesting container. The data directory therefore sits at the identical absolute path on the host and inside the app container, and `compose.yaml` mounts it that way from a single `DATA_DIR` value.
- **One public origin port.** nginx publishes HTTPS on port 443. It accepts public requests only from Cloudflare address ranges and requires Cloudflare's Global Authenticated Origin Pulls certificate. It serves the configured public hostname with a generated self-signed certificate. This combination requires Cloudflare SSL/TLS mode **Full**, not **Full (strict)**.
- **One loopback origin port.** nginx publishes a second HTTPS listener on IPv4 loopback, port 8443 by default. It serves the full site for local administration and health checks without Cloudflare client authentication. It accepts only the `localhost` and `127.0.0.1` hostnames.
- **No published app ports.** nginx reaches the app through a named internal Docker network. LLM-enabled session relays join that network and target the app service directly. The app's HTTP and internal LLM listener ports never bind to the host. [Execution](execution.md#live-sessions) defines the session-side network path.
- **One backend per daemon.** At startup the backend reaps leftover containers from a previous run, telling a previous incarnation of itself from a live peer by process id. Process ids are namespace-local, so that distinction only works across host processes: host-process backends may share a daemon safely, while a containerized backend must be its daemon's only backend.
- **A single-tenant machine.** The mounted daemon socket grants full control of the daemon, which is root-equivalent on the host. The machine hosting a containerized deployment runs nothing that must be protected from this app.

Docker Desktop on Windows and macOS runs containers inside a hidden VM whose filesystem is not the host's, which breaks the one-data-path rule. Those platforms use host-process mode.

The origin certificate and key live under the ignored host directory `.tls/`. The proxy creates a certificate for the exact `PUBLIC_ORIGIN` hostname plus loopback names, checks it daily, and atomically renews and reloads nginx before expiration. The proxy build bundles Cloudflare's published IPv4 and IPv6 ranges and Global Authenticated Origin Pulls trust certificate. Updating either requires rebuilding and recreating the proxy. The host firewall or provider security group should independently restrict origin port 443 to the same Cloudflare ranges.

Setup steps live in the contributor guide: [Run the app in Docker](../contributors/setup/docker.md).
