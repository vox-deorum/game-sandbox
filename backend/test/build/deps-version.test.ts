import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  KNOWN_DEPS_VERSIONS,
  sessionBaseImageDefinition,
  sessionBaseImageInputs,
} from '../../src/build/deps-version.js'
import { imageTag } from '../../src/driver/docker/image.js'

/** The build-context sources of every COPY or ADD instruction, skipping multi-stage `--from` copies. */
function copySources(dockerfile: string): string[] {
  return dockerfile.split('\n').flatMap((line) => {
    const [instruction = '', ...args] = line.trim().split(/\s+/)
    if (!/^(COPY|ADD)$/i.test(instruction) || args.some((arg) => arg.startsWith('--from='))) {
      return []
    }
    return args.filter((arg) => !arg.startsWith('--')).slice(0, -1)
  })
}

describe('dependency-set image registry', () => {
  it('builds every known version only from the trees its digest hashes, keeping v1 forever', () => {
    // A released version is never removed from the registry (old submissions still resolve to it),
    // so v1 is always present.
    expect(KNOWN_DEPS_VERSIONS.has(1)).toBe(true)
    for (const n of KNOWN_DEPS_VERSIONS) {
      const definition = sessionBaseImageDefinition(n)
      const dockerfile = readFileSync(
        new URL(`../../../${definition.dockerfile}`, import.meta.url),
        'utf8',
      )
      // A source outside the digested trees could change without moving the digest, so a stale
      // image would be reused. This also keeps another version's frozen inputs out of the build.
      const inputs = sessionBaseImageInputs(definition)
      const sources = copySources(dockerfile)
      expect(sources).not.toEqual([])
      expect(
        sources.filter(
          (source) => !inputs.some((input) => source === input || source.startsWith(`${input}/`)),
        ),
      ).toEqual([])
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
