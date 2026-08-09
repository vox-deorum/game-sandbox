"""Refresh the Cloudflare source CIDRs used by the nginx origin proxy."""

from __future__ import annotations

import argparse
import ipaddress
import os
import tempfile
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

IPV4_URL = "https://www.cloudflare.com/ips-v4"
IPV6_URL = "https://www.cloudflare.com/ips-v6"
DEFAULT_OUTPUT = Path("deploy/nginx/cloudflare-allow.conf")


def fetch_text(url: str, opener: Callable[..., Any] | None = None) -> str:
    """Download a small UTF-8 Cloudflare CIDR document."""
    request = urllib.request.Request(url, headers={"User-Agent": "game-sandbox-cloudflare-updater"})
    open_url = urllib.request.urlopen if opener is None else opener
    with open_url(request, timeout=30) as response:
        return response.read().decode("utf-8")


def parse_networks(text: str, version: int) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    """Validate and sort a Cloudflare plain-text CIDR response."""
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for line in text.splitlines():
        cidr = line.strip()
        if not cidr:
            continue
        network = ipaddress.ip_network(cidr, strict=True)
        if network.version != version:
            msg = f"expected IPv{version} CIDR, got {cidr!r}"
            raise ValueError(msg)
        networks.append(network)
    if not networks:
        msg = f"Cloudflare IPv{version} response contained no CIDRs"
        raise ValueError(msg)
    return sorted(networks, key=lambda item: (int(item.network_address), item.prefixlen))


def render_allowlist(
    ipv4: list[ipaddress.IPv4Network | ipaddress.IPv6Network],
    ipv6: list[ipaddress.IPv4Network | ipaddress.IPv6Network],
) -> str:
    """Render the nginx access directives without machine-specific state."""
    lines = [
        f"# Generated from {IPV4_URL} and {IPV6_URL}.",
        "# Run scripts/update_cloudflare_material.py to refresh this list. Rebuild and recreate the proxy",
        "# after updating it, then refresh any external firewall allowlist with the same ranges.",
    ]
    lines.extend(f"allow {network};" for network in [*ipv4, *ipv6])
    lines.append("deny all;")
    return "\n".join(lines) + "\n"


def write_atomically(path: Path, content: str) -> None:
    """Replace the generated file atomically only when its content changed."""
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as temporary_file:
            temporary_file.write(content)
        os.replace(temporary_name, path)
    except BaseException:
        Path(temporary_name).unlink(missing_ok=True)
        raise


def update(output: Path, opener: Callable[..., object] | None = None) -> None:
    """Fetch both official lists and atomically write the nginx include file."""
    ipv4 = parse_networks(fetch_text(IPV4_URL, opener), 4)
    ipv6 = parse_networks(fetch_text(IPV6_URL, opener), 6)
    write_atomically(output, render_allowlist(ipv4, ipv6))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    arguments = parser.parse_args()
    update(arguments.output)


if __name__ == "__main__":
    main()
