from __future__ import annotations

import hashlib
import ssl
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

# The dev scripts are run as top-level modules (scripts/ on sys.path), so mirror that here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from update_cloudflare_material import IPV4_URL, IPV6_URL, parse_networks, update


class FakeResponse:
    def __init__(self, body: str) -> None:
        self.body = body.encode()

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


def test_update_writes_sorted_deterministic_allowlist_atomically(tmp_path: Path) -> None:
    responses = {
        IPV4_URL: "198.41.128.0/17\n103.21.244.0/22\n",
        IPV6_URL: "2606:4700::/32\n2400:cb00::/32\n",
    }

    def opener(request: object, timeout: int) -> FakeResponse:
        assert timeout == 30
        return FakeResponse(responses[request.full_url])  # type: ignore[attr-defined]

    output = tmp_path / "nested" / "cloudflare-allow.conf"
    update(output, opener)
    first = output.read_text(encoding="utf-8")
    update(output, opener)

    assert output.read_text(encoding="utf-8") == first
    assert "allow 103.21.244.0/22;" in first
    assert first.index("allow 103.21.244.0/22;") < first.index("allow 198.41.128.0/17;")
    assert "Rebuild and recreate the proxy" in first
    assert "external firewall allowlist" in first
    assert not list(output.parent.glob(".cloudflare-allow.conf.*"))


def test_parse_networks_rejects_wrong_address_family() -> None:
    with pytest.raises(ValueError, match="expected IPv4 CIDR"):
        parse_networks("2606:4700::/32\n", 4)


def test_bundled_cloudflare_certificate_is_current_and_has_expected_fingerprint() -> None:
    certificate = Path("deploy/nginx/cloudflare-origin-pull-ca.pem")
    metadata = Path("deploy/nginx/cloudflare-origin-pull-ca.metadata").read_text(encoding="utf-8")
    assert "https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem" in metadata
    fingerprint = hashlib.sha256(
        ssl.PEM_cert_to_DER_cert(certificate.read_text(encoding="utf-8"))
    ).hexdigest()
    assert fingerprint == "9a1ac2b4be15f9f27eee20a734cba4e9898f61001b3bd7c84b69b56a3e25a2b9"
    assert f"SHA-256 certificate fingerprint (DER): {fingerprint}" in metadata

    decoded = vars(ssl)["_ssl"]._test_decode_cert(str(certificate))
    assert decoded["subject"]
    not_after = decoded["notAfter"]
    assert isinstance(not_after, str)
    expires = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=UTC)
    assert expires > datetime.now(UTC) + timedelta(days=30)
