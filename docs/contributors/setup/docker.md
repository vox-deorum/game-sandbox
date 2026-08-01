# Run the app in Docker

The repository root has a `Dockerfile` and `compose.yaml` that run the whole app, the backend serving the built frontend, inside one container. That container starts session containers itself, so `docker compose up` gives a self-contained deployment with no host-installed Node or Python. The [Deployment](../../specs/deployment.md) specification defines this mode and its rules. See [Configuration](configuration.md) for the full variable reference and [Development setup](development.md) for the host-process flow.

## Procedure

1. Create `.env` at the repository root with real credentials. A deployment must set these explicitly; see [Deployment notes](configuration.md#deployment-notes):

   ```dotenv
   PUBLIC_ORIGIN=https://sandbox.example.edu
   AUTH_SECRET=<32 or more random characters>
   ADMIN_EMAIL=admin@example.edu
   ADMIN_PASSWORD=<a real password>
   ADMIN_NAME=Admin
   AUTH_ALLOW_INSECURE_DEFAULTS=false
   DATA_DIR=/srv/game-sandbox/data
   ```

2. Create the host data directory at the path named by `DATA_DIR`, so it exists before the container starts:

   ```console
   mkdir -p /srv/game-sandbox/data
   ```

3. Build and start the stack:

   ```console
   docker compose up -d --build
   ```

   The first session started after this builds the session-base image from inside the container. That is expected and can take a while.

The manually triggered Compose smoke workflow rehearses this deployment on a Linux CI runner; see [Compose deployment smoke](../testing/index.md#compose-deployment-smoke).

## How the container is set up

`compose.yaml` mounts `/var/run/docker.sock` into the `app` container, so the backend inside it talks to the same Docker daemon as the host and starts session containers as siblings, not nested inside itself.

Session containers bind-mount `<DATA_DIR>/recordings`, and the Docker daemon resolves a bind path against its own host filesystem, not the caller's. So `DATA_DIR` must be an absolute path that exists identically on the host and inside the `app` container. `compose.yaml` guarantees this: it bind-mounts `${DATA_DIR:-/srv/game-sandbox/data}` at that same path inside the container, reading the value from the same `.env` file the backend reads, so one `DATA_DIR` value feeds both sides.

Mounting the Docker socket grants full control of the host's Docker daemon, so treat the host as single-tenant for this app.

A containerized backend must be the only backend using its Docker daemon. The backend labels the containers it starts with its own process id and reaps leftover containers whose labeled owner process is gone or is itself. Inside a container those ids are namespace-local, so a containerized backend cannot tell another backend's live process from a dead one and would reap its sessions. Only host-process backends see each other's real process ids, so only they can share a daemon safely.

## Supported hosts

This setup needs a Linux Docker daemon that shares a filesystem with the compose project: a real Linux host, or Docker Engine inside WSL2. Docker Desktop on Windows or macOS runs containers inside a VM and translates bind paths through it, which breaks the same-path rule above. On those platforms, run the app as a host process instead, following [Development setup](development.md).

## LLM sessions

Each LLM-enabled session gets a relay container that reaches the backend's LLM proxy at `host.docker.internal` on `LLM_INTERNAL_PORT`. `compose.yaml` publishes that port from the `app` container to the host, which keeps this path working; see [LLM proxy](configuration.md#llm-proxy) for the rest of the proxy's configuration.
