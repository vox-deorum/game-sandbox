# Docker edge proxy

Status: Complete

This change places the containerized app behind an nginx TLS origin and removes direct host access to the app and LLM listener.

## Build

- Build the proxy from the current official `nginx:alpine` image and pull the base on every setup build.
- Generate and validate a host-persisted self-signed origin certificate for the configured public hostname and loopback access. Check it daily and atomically renew and reload before expiration.
- Accept public HTTPS only from Cloudflare addresses with Cloudflare Global Authenticated Origin Pulls.
- Publish a separate HTTPS listener on IPv4 loopback for local administration and health checks.
- Keep the app, proxy, and LLM relay on a named internal Docker network. Keep sandbox agents isolated from that network.
- Preserve the host-gateway relay topology as the default for host-process deployments.
- Update setup, smoke tests, configuration reference, deployment specification, and operator instructions.

## Exit criteria

- Direct app and LLM host ports are not published by Compose.
- Public proxy requests require both a Cloudflare source address and the Global AOP client certificate.
- Local HTTPS reaches the full site without AOP and rejects non-loopback hostnames.
- HTTP and WebSocket traffic survives app container recreation.
- An LLM-enabled session reaches the internal listener through the relay without exposing it to the agent container.
- Unit and integration tests, Compose validation, proxy image validation, the deployment smoke workflow, and documentation build cover the topology.
