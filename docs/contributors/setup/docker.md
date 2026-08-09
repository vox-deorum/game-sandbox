# Run the app in Docker

The repository root has a `Dockerfile` and `compose.yaml` that run the app behind an nginx HTTPS origin. The app container starts session containers itself, so the stack needs no host-installed Node or Python. The [Deployment](../../specs/deployment.md) specification defines this mode and its rules. See [Configuration](configuration.md) for the full variable reference and [Development setup](development.md) for the host-process flow.

The public listener is designed for a Cloudflare-proxied hostname. It accepts only Cloudflare source networks with Cloudflare Global Authenticated Origin Pulls. A separate HTTPS listener binds only to `127.0.0.1` for local administration and health checks.

## Procedure

The repository setup script automates the local server steps, including the certificate directory, current-image build, startup, and HTTPS health wait. Run `./setup.sh` from Linux or WSL2 and choose Docker deployment. The manual steps below remain the reference procedure.

1. Create `.env` at the repository root with real credentials. A deployment must set these explicitly; see [Deployment notes](configuration.md#deployment-notes):

   ```dotenv
   PUBLIC_ORIGIN=https://sandbox.example.edu
   AUTH_SECRET=<32 or more random characters>
   ADMIN_EMAIL=admin@example.edu
   ADMIN_PASSWORD=<a real password>
   ADMIN_NAME=Admin
   AUTH_ALLOW_INSECURE_DEFAULTS=false
   DATA_DIR=/srv/game-sandbox/data
   LOCAL_HTTPS_PORT=8443
   ```

   `PUBLIC_ORIGIN` must be exactly `https://` followed by an ASCII multi-label DNS hostname. Do not include a port, path, trailing slash, trailing dot, or IP address. `LOCAL_HTTPS_PORT` may be changed, but it cannot be `443`, which is reserved for public HTTPS.

2. Create the host data directory and private certificate directory before the containers start:

   ```console
   mkdir -p /srv/game-sandbox/data
   mkdir -m 700 .tls
   ```

   The proxy generates `.tls/current/origin.crt` and `.tls/current/origin.key` on first start. `current` is an atomic link to a complete pair. The proxy validates the pair at startup and checks it daily while running. It renews when fewer than 30 days remain, reloads nginx, and retains one `previous` pair. These files are ignored by Git. Back up the whole `.tls` directory if local clients trust the certificate.

3. Build with current base images and start the stack:

   ```console
   docker compose build --pull
   docker compose up -d
   ```

   The proxy image uses the floating official `nginx:alpine` base. `--pull` is required on every deployment build so it resolves to the latest published nginx Alpine image instead of a cached base.

4. Confirm local HTTPS from the server:

   ```console
   curl --cacert .tls/current/origin.crt https://127.0.0.1:8443/api/environments
   ```

   Opening `https://127.0.0.1:8443` in a browser provides the full site, including email sign-in. The browser warns until you explicitly trust the self-signed certificate. GitHub OAuth callbacks still use `PUBLIC_ORIGIN`, so complete that sign-in through the public hostname.

5. Create a proxied Cloudflare DNS record for `PUBLIC_ORIGIN`, pointing at the origin's public IPv4 address only, then configure the zone. Do not add an IPv6 address: the stack's Docker networks are IPv4-only, so an IPv6 connection reaches nginx through Docker's userland proxy with a rewritten source address that the Cloudflare allowlist rejects.

   - Set [SSL/TLS encryption mode to **Full**](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full/). The generated origin certificate is self-signed, so **Full (strict)** rejects it.
   - Enable [Global Authenticated Origin Pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/set-up/global/) for the zone. Per-hostname Authenticated Origin Pulls use a custom certificate and are not compatible with the proxy's bundled Global Authenticated Origin Pulls certificate.
   - Enable [Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/) at the edge. The origin does not publish plaintext port 80.
   - Restrict inbound TCP port 443 in the host firewall or provider security group to [Cloudflare's published IPv4 and IPv6 networks](https://www.cloudflare.com/ips/). Keep the nginx allowlist as a second check.

   Do not create an unproxied DNS record for the origin. A request that bypasses Cloudflare cannot satisfy both the source allowlist and client-certificate check.

   The first session started after this builds the session-base image from inside the container. That is expected and can take a while.

The manually triggered Compose smoke workflow rehearses this deployment on a Linux CI runner; see [Compose deployment smoke](../testing/index.md#compose-deployment-smoke).

## How the container is set up

`compose.yaml` mounts `/var/run/docker.sock` into the `app` container, so the backend inside it talks to the same Docker daemon as the host and starts session containers as siblings, not nested inside itself. The app has an outbound network for GitHub and model providers plus the named internal `game-sandbox-internal` network. nginx has only the internal network.

The app publishes no host ports. nginx publishes public port 443 and binds `${LOCAL_HTTPS_PORT:-8443}` to IPv4 loopback. It forwards HTTP and WebSocket traffic to the app through Docker DNS, including after the app container is recreated.

Session containers bind-mount `<DATA_DIR>/recordings`, and the Docker daemon resolves a bind path against its own host filesystem, not the caller's. So `DATA_DIR` must be an absolute path that exists identically on the host and inside the `app` container. `compose.yaml` guarantees this: it bind-mounts `${DATA_DIR:-/srv/game-sandbox/data}` at that same path inside the container, reading the value from the same `.env` file the backend reads, so one `DATA_DIR` value feeds both sides.

Mounting the Docker socket grants full control of the host's Docker daemon, so treat the host as single-tenant for this app.

A containerized backend must be the only backend using its Docker daemon. The backend labels the containers it starts with its own process id and reaps leftover containers whose labeled owner process is gone or is itself. Inside a container those ids are namespace-local, so a containerized backend cannot tell another backend's live process from a dead one and would reap its sessions. Only host-process backends see each other's real process ids, so only they can share a daemon safely.

## Supported hosts

This setup needs a Linux Docker daemon that shares a filesystem with the compose project: a real Linux host, or Docker Engine inside WSL2. Docker Desktop on Windows or macOS runs containers inside a VM and translates bind paths through it, which breaks the same-path rule above. On those platforms, run the app as a host process instead, following [Development setup](development.md).

## LLM sessions

Each LLM-enabled session gets a fixed-destination relay. In this Compose topology the relay joins `game-sandbox-internal` and reaches the backend service at `app:LLM_INTERNAL_PORT`. The agent container remains on its own isolated network and can resolve only its relay alias. The internal listener is not published on the host. Host-process deployments retain the host-gateway relay mode; see [LLM proxy](configuration.md#llm-proxy).

## Maintaining the Cloudflare boundary

Cloudflare can change its published address ranges. Refresh the tracked nginx include with:

```console
python3 scripts/update_cloudflare_material.py
docker compose build --pull proxy
docker compose up -d --force-recreate proxy
```

Review the generated diff before deployment, then apply the same IPv4 and IPv6 ranges to the host firewall or provider security group. The updater validates both downloads and replaces the tracked file only after both are valid.

Recreating the proxy severs live game connections after its ten-second stop window, so schedule refreshes for a quiet moment.

The tracked Global Authenticated Origin Pulls CA certificate comes from Cloudflare's official nginx setup documentation. When Cloudflare replaces it, download the new certificate from that official source and independently inspect its fingerprint and validity before changing the repository. Update the PEM file, metadata, and expected test fingerprint together, then rebuild and recreate the proxy. The test guards the reviewed fingerprint and expiration; it does not discover whether Cloudflare has published a replacement.
