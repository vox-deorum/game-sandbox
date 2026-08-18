/**
 * Admission guards for participant-supplied git URLs.
 *
 * The backend will `git ls-remote`/`fetch` whatever URL a participant submits, so the URL is an
 * SSRF surface. Two layers apply before any network I/O:
 *
 * 1. A structural check (scheme, no embedded credentials, no query/fragment) that runs
 *    synchronously and is also reused by the submission API's wire schema.
 * 2. A DNS-backed resolution check that refuses hosts resolving to loopback, link-local,
 *    metadata, private, or otherwise internal addresses, so the fetch cannot be pivoted onto the
 *    backend's own network (including the internal LLM proxy and metadata endpoints).
 *
 * The resolved address check is a pre-flight guard: git performs its own resolution for the
 * actual connection, so a DNS-rebinding host could in principle point elsewhere afterwards. That
 * residual is accepted because the primary targets — metadata endpoints and plain private
 * addresses — are caught before git ever runs.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { SourceError } from './types.js'

/** The resolver seam: production uses the system DNS; tests inject a fixed public answer. */
export interface HostResolver {
  lookup(hostname: string): Promise<ReadonlyArray<{ address: string; family: number }>>
}

/** The production resolver, bound to the system DNS. */
export const defaultHostResolver: HostResolver = {
  async lookup(hostname) {
    const records = await dnsLookup(hostname, { all: true, verbatim: true })
    return records.map((record) => ({ address: record.address, family: record.family }))
  },
}

/** Hostnames that never name a participant repository, whatever they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'host.docker.internal',
  'metadata.google.internal',
  'gateway.docker.internal',
])
/** Hostname suffixes that identify internal namespaces rather than public repositories. */
const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home', '.lan']

/** Whether a bare hostname is an internal name that must never be submitted as a repo host. */
export function isBlockedInternalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOSTNAMES.has(host)) {
    return true
  }
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/** Whether an IPv4 dotted-quad falls in a private, link-local, metadata, or reserved range. */
function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part))
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    // Not a well-formed dotted quad (the caller only reaches here for `isIP`=4, so this is
    // unreachable in practice); reject conservatively.
    return true
  }
  const [a, b, c] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? -1]
  if (a === 0 || a === 10 || a === 127) return true // this-network, private-10, loopback
  if (a === 169 && b === 254) return true // link-local (metadata 169.254.169.254 included)
  if (a === 172 && b >= 16 && b <= 31) return true // private-172.16/12
  if (a === 192 && b === 168) return true // private-192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast and reserved
  return false
}

/** Whether an IPv6 address is loopback, ULA, link-local, multicast, documentation, or v4-mapped. */
function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length)
    return isIP(v4) === 4 && isPrivateIpv4(v4)
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7 ULA
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  )
    return true // fe80::/10 link-local
  if (lower.startsWith('ff') || lower.startsWith('2001:db8')) return true // multicast / documentation
  return false
}

/** Whether an IP literal names loopback, link-local, private, metadata, or reserved space. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return isPrivateIpv4(address)
  if (kind === 6) return isPrivateIpv6(address)
  return true // unparseable — reject conservatively
}

/**
 * The synchronous structural guard shared by the source seam and the wire schema: refuses a URL
 * that is not a bare http(s) repository URL. Never throws; returns an owner-facing message when
 * the URL is not admissible, or null when it is.
 */
export function unsafeGitUrlReason(repoUrl: string): string | null {
  let url: URL
  try {
    url = new URL(repoUrl)
  } catch {
    return 'only http(s) git URLs are supported'
  }
  if (repoUrl.trim() !== repoUrl) {
    return 'the repository URL must not have surrounding whitespace'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'only http(s) git URLs are supported'
  }
  if (url.username !== '' || url.password !== '') {
    return 'the repository URL must not embed credentials'
  }
  if (url.search !== '' || url.hash !== '') {
    return 'the repository URL must not contain a query or fragment'
  }
  return null
}

/**
 * The full admission guard: the structural check, then a resolution check refusing hosts that
 * resolve to an internal or private address. Throws a typed {@link SourceError}.
 */
export async function assertSafeGitTarget(repoUrl: string, resolver: HostResolver): Promise<void> {
  const reason = unsafeGitUrlReason(repoUrl)
  if (reason !== null) {
    throw new SourceError('invalid_input', reason)
  }
  const hostname = new URL(repoUrl).hostname
  if (isBlockedInternalHostname(hostname)) {
    throw new SourceError('invalid_input', 'the repository host must not be an internal hostname')
  }
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new SourceError('invalid_input', 'the repository host must be a public address')
    }
    return
  }
  let addresses: ReadonlyArray<{ address: string; family: number }>
  try {
    addresses = await resolver.lookup(hostname)
  } catch {
    throw new SourceError('unreachable', 'the repository hostname could not be resolved')
  }
  if (addresses.length === 0) {
    throw new SourceError('unreachable', 'the repository hostname could not be resolved')
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new SourceError('invalid_input', 'the repository host must be a public address')
  }
}
