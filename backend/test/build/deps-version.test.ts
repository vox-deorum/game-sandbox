import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  KNOWN_DEPS_VERSIONS,
  sessionBaseImageDefinition,
  sessionBaseImageInputs,
} from '../../src/build/deps-version.js'
import { imageTag } from '../../src/driver/docker/image.js'

describe('dependency-set image registry', () => {
  it('backs every known version with an explicit image definition, keeping v1 forever', () => {
    // A released version is never removed from the registry (old submissions still resolve to it),
    // so v1 is always present.
    expect(KNOWN_DEPS_VERSIONS.has(1)).toBe(true)
    for (const n of KNOWN_DEPS_VERSIONS) {
      expect(sessionBaseImageDefinition(n)).toEqual({
        dockerfile: `backend/images/session-base/deps-v${n}/Dockerfile`,
      })
    }
  })

  it('builds each version from its own frozen dependency and built-in-agent inputs', () => {
    for (const n of KNOWN_DEPS_VERSIONS) {
      const dockerfile = readFileSync(
        new URL(`../../images/session-base/deps-v${n}/Dockerfile`, import.meta.url),
        'utf8',
      )
      // Each versioned Dockerfile COPYs only its own deps-v<n> inputs — never the mutable template
      // requirements or a compose step, and never another version's directory.
      expect(dockerfile).toContain(`backend/images/session-base/deps-v${n}/requirements.txt`)
      expect(dockerfile).toContain(`backend/images/session-base/deps-v${n}/builtin`)
      expect(dockerfile).not.toContain('COPY templates/base/requirements.txt')
      expect(dockerfile).not.toContain('scripts/compose.py')
      for (const other of KNOWN_DEPS_VERSIONS) {
        if (other !== n) {
          expect(dockerfile).not.toContain(`deps-v${other}/`)
        }
      }
    }
  })

  it('digests each version from its Dockerfile directory plus the copied source trees', () => {
    for (const n of KNOWN_DEPS_VERSIONS) {
      expect(sessionBaseImageInputs(sessionBaseImageDefinition(n))).toEqual([
        `backend/images/session-base/deps-v${n}`,
        'harness',
        'environments',
      ])
    }
  })

  it('refuses to name or build an unsupported dependency version', () => {
    const unsupported = Math.max(...KNOWN_DEPS_VERSIONS) + 1
    const message = new RegExp(`unsupported dependency-set version ${unsupported}`)
    expect(() => sessionBaseImageDefinition(unsupported)).toThrow(message)
    expect(() =>
      imageTag('game-sandbox', { kind: 'session-base', depsVersion: unsupported }),
    ).toThrow(message)
  })
})
