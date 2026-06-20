import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  currentSessionBaseImageSpec,
  DEPS_VERSION,
  KNOWN_DEPS_VERSIONS,
  sessionBaseImageDefinition,
} from '../src/deps-version.js'
import { imageTag } from '../src/driver/docker/image.js'

describe('dependency-set image registry', () => {
  it('backs every accepted version with an explicit image definition', () => {
    expect([...KNOWN_DEPS_VERSIONS]).toEqual([1])
    expect(sessionBaseImageDefinition(1)).toEqual({
      dockerfile: 'backend/images/session-base/deps-v1/Dockerfile',
    })
  })

  it('builds v1 from frozen dependency and built-in-agent inputs', () => {
    const dockerfile = readFileSync(
      new URL('../images/session-base/deps-v1/Dockerfile', import.meta.url),
      'utf8',
    )
    expect(dockerfile).toContain('backend/images/session-base/deps-v1/requirements.txt')
    expect(dockerfile).toContain('backend/images/session-base/deps-v1/builtin')
    expect(dockerfile).not.toContain('COPY templates/base/requirements.txt')
    expect(dockerfile).not.toContain('scripts/compose.py')
  })

  it('keeps the current version tied to a registered definition', () => {
    expect(currentSessionBaseImageSpec()).toEqual({
      kind: 'session-base',
      depsVersion: DEPS_VERSION,
    })
    expect(() => sessionBaseImageDefinition(DEPS_VERSION)).not.toThrow()
  })

  it('refuses to name or build an unsupported dependency version', () => {
    expect(() => sessionBaseImageDefinition(2)).toThrow(/unsupported dependency-set version 2/)
    expect(() => imageTag('game-sandbox', { kind: 'session-base', depsVersion: 2 })).toThrow(
      /unsupported dependency-set version 2/,
    )
  })
})
