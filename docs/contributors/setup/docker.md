# Run the app in Docker

The repository root has a `Dockerfile` and `compose.yaml` that run the app behind an nginx HTTPS origin. The Compose `app` container runs the backend and starts session containers, so the stack needs no host-installed Node or Python. The [Deployment](../../specs/deployment.md) specification defines this mode and its rules. See [Configuration](configuration.md) for the full variable reference and [Development setup](development.md) for the host-process flow.

The public listener is designed for a Cloudflare-proxied hostname. It accepts only Cloudflare source networks with Cloudflare Global Authenticated Origin Pulls. A separate HTTPS listener binds only to `127.0.0.1` for local administration and health checks.

## Prerequisites

Use a Linux host or Docker Engine in WSL2, with Docker Compose access, permission to create `DATA_DIR`, a Cloudflare DNS hostname, and permission to open inbound port 443. Docker Desktop on Windows or macOS translates bind paths through a VM, so use the [host-process setup](development.md) there.

## Procedure

The repository setup script automates server setup, including the certificate directory, current-image build, startup, and HTTPS health wait. Run `./setup.sh` from Linux or WSL2 and choose Docker deployment. The manual steps below remain the reference procedure.

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

   `PUBLIC_ORIGIN` must be exactly `https://` followed by an ASCII multi-label DNS hostname. Do not include a port, path, trailing slash, trailing dot, or IP address. `LOCAL_HTTPS_PORT` may be changed, but it cannot be `443`, which is reserved for public HTTPS. `APP_UID`, `APP_GID`, and `DOCKER_GID` are optional overrides described in [Configuration](configuration.md); the defaults fit most hosts.

2. Create the host data directory and private certificate directory before the containers start:

   ```console
   mkdir -p /srv/game-sandbox/data
   mkdir -m 700 .tls
   ```

   The app container takes ownership of `DATA_DIR` at startup, so the directory does not need to belong to any particular account beforehand. The proxy generates `.tls/current/origin.crt` and `.tls/current/origin.key` on first start. `current` is an atomic link to a complete pair. The proxy validates the pair at startup and checks it daily while running. It renews when fewer than 30 days remain, reloads nginx, and retains one `previous` pair. These files are ignored by Git. [Data folders](../data/folders.md) describes the proxy mount and other local storage. Back up the whole `.tls` directory if local clients trust the certificate.

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
   - Enable [Global Authenticated Origin Pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/set-up/global/) for the zone. Per-hostname Authenticated Origin Pulls use a custom client certificate and require separately managed origin trust, which this deployment does not configure.
   - Enable [Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/) at the edge. The origin does not publish plaintext port 80.
   - Restrict inbound TCP port 443 in the host firewall or provider security group to [Cloudflare's published IPv4 and IPv6 networks](https://www.cloudflare.com/ips/). Keep the nginx allowlist as a second check.

   Do not create an unproxied DNS record for the origin. A request that bypasses Cloudflare cannot satisfy both the source allowlist and client-certificate check.

   The first session after deployment builds the session-base image from inside the container. That is expected and can take a while.

The manually triggered Compose smoke workflow rehearses this deployment on a Linux CI runner; see [Compose deployment smoke](../testing/index.md#compose-deployment-smoke).

## How the container is set up

`compose.yaml` mounts `/var/run/docker.sock` (read-only) into the Compose `app` container, so its backend starts sibling session containers on the host daemon. The app image bakes a non-root app account at uid/gid `1001`; its entrypoint starts as root just long enough to remap that account to the host's `APP_UID`/`APP_GID` (which must be the numeric owner of the bind-mounted `DATA_DIR`), join it to a group matching the socket's gid, and chown `DATA_DIR`, then it drops to the app account and execs the backend. No host-specific gid is pinned in Compose, and `APP_UID`/`APP_GID`/`DOCKER_GID` changes never require an image rebuild; the defaults match the `exouser` account this deployment uses. The Compose `app` container joins an outbound network for GitHub and model providers and the `game-sandbox-internal` network. nginx joins both of those networks. It needs the outbound one only to be reachable at all: Docker binds a published port through a container's endpoint on a non-internal network, and the internal network is gateway-free, so an nginx attached to that network alone leaves every published port unbound on the host. nginx addresses the app by the `app-internal` alias, which the app carries only on the internal network, so traffic to the app never crosses the outbound one.

The Compose `app` container publishes no host ports. nginx publishes public port 443 and binds `${LOCAL_HTTPS_PORT:-8443}` to IPv4 loopback. It forwards HTTP and WebSocket traffic to the Compose `app` container through Docker DNS, including after that container is recreated.

Session containers bind-mount `<DATA_DIR>/recordings`, so `DATA_DIR` must be an existing absolute path that is identical on the host and in the Compose `app` container. `compose.yaml` binds the configured path at itself. See [Data folders](../data/folders.md).

Mounting the Docker socket grants full control of the host's Docker daemon, so treat the host as single-tenant for this app. The read-only mount and non-root backend are hardening, not containment: a compromised backend still has the daemon's authority.

A containerized backend must be the only backend using its Docker daemon because namespace-local process IDs make another backend's live sessions look orphaned. Host-process backends see shared process IDs and can share a daemon safely.

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
