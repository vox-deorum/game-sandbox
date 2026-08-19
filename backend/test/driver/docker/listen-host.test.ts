/**
 * Unit coverage for the internal-LLM-listener interface resolution (the cgroup-v2-safe replacement
 * for /proc/self/cgroup container-id parsing): matching the local interface that sits on one of the
 * relay network's subnets. Pure function, no daemon. The compose-network integration suite rides the
 * Docker-gated path.
 */
import type { NetworkInterfaceInfo } from 'node:os'

import { describe, expect, it } from 'vitest'

import { resolveLlmListenHost } from '../../../src/driver/docker/index.js'

function iface(
  address: string,
  family: NetworkInterfaceInfo['family'] = 'IPv4',
): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family,
    mac: '00:00:00:00:00:00',
    internal: true,
    cidr: `${address}/24`,
    scopeid: 0,
  }
}

describe('resolveLlmListenHost', () => {
  it('returns the local interface address inside one of the network subnets', () => {
    // The backend container sits on the internal network's 172.18.0.0/16 and the outbound 172.19.0.0/16.
    const interfaces = [iface('172.19.0.5'), iface('172.18.0.3')]
    expect(resolveLlmListenHost(['172.18.0.0/16', '10.0.0.0/8'], interfaces)).toBe('172.18.0.3')
  })

  it('returns undefined when no interface is on the relay subnet (host-process dev mode)', () => {
    const interfaces = [iface('192.168.1.5')]
    expect(resolveLlmListenHost(['172.18.0.0/16'], interfaces)).toBeUndefined()
  })

  it('ignores IPv6 and malformed entries, matching only IPv4 addresses', () => {
    const interfaces = [iface('fe80::1', 'IPv6'), iface('not-an-ip'), iface('999.1.1.1')]
    expect(resolveLlmListenHost(['127.0.0.0/8'], interfaces)).toBeUndefined()
  })

  it('matches a /32 host subnet exactly and treats a malformed cidr as no match', () => {
    const interfaces = [iface('10.0.0.9')]
    expect(resolveLlmListenHost(['10.0.0.9/32'], interfaces)).toBe('10.0.0.9')
    expect(resolveLlmListenHost(['10.0.0.8/32'], interfaces)).toBeUndefined()
    expect(resolveLlmListenHost(['10.0.0.0/33', 'not-a-cidr'], interfaces)).toBeUndefined()
  })

  it('returns undefined for an empty subnet list', () => {
    expect(resolveLlmListenHost([], [iface('172.18.0.3')])).toBeUndefined()
  })
})
