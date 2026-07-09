import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { Auth } from '../src/auth/auth.js'
import { buildDocsManifest, DocsIndexError, readDocsIndex, readDocsPage } from '../src/docs.js'
import { RecordingsStore } from '../src/recordings.js'
import { Retention } from '../src/retention.js'
import { Orchestrator } from '../src/session/orchestrator.js'
import type { Storage } from '../src/storage/index.js'
import { FakeDriver } from './support/fake-driver.js'
import {
  makeConfig,
  makeEnvironments,
  makeSubmissionDeps,
  openTestStack,
} from './support/harness.js'

// A miniature docs/ tree: the students subtree the website serves, plus an out-of-scope contributors
// file to prove it is never reachable. `fenced-only.md` has no real H1 and a `#` only inside a fence,
// so it exercises the fence-aware title scan and the humanized-filename fallback.
function writeFixtureDocs(): string {
  const docsDir = mkdtempSync(join(tmpdir(), 'gs-docs-'))
  const students = join(docsDir, 'students')
  const environments = join(students, 'environments')
  mkdirSync(environments, { recursive: true })
  mkdirSync(join(docsDir, 'contributors'), { recursive: true })

  writeFileSync(join(students, 'index.md'), '# For Students\n\nThe landing page.\n')
  writeFileSync(join(students, 'getting-started.md'), '# Getting Started\n\nSet up Python.\n')
  writeFileSync(join(students, 'agent-interface.md'), '# Agent Interface\n\nThe contract.\n')
  writeFileSync(join(students, 'submitting.md'), '# Submitting\n\nPush and submit.\n')
  writeFileSync(
    join(students, 'fenced-only.md'),
    '```python\n# not a heading\n```\n\nProse with no top-level heading.\n',
  )
  writeFileSync(join(environments, 'index.md'), '# Environments\n\nPick a game.\n')
  writeFileSync(
    join(environments, 'flappy-bird.md'),
    '# Flappy Bird\n\n```text\n# a comment, not a heading\n```\n',
  )
  writeFileSync(join(environments, 'hearts.md'), '# Hearts\n\nAvoid points.\n')
  writeFileSync(join(environments, 'spades.md'), '# Spades\n\nBid your tricks.\n')
  writeFileSync(join(docsDir, 'contributors', 'secret.md'), '# Secret\n\nOut of scope.\n')
  return docsDir
}

describe('docs module', () => {
  let docsDir: string

  beforeEach(() => {
    docsDir = writeFixtureDocs()
  })

  afterEach(() => {
    rmSync(docsDir, { recursive: true, force: true })
  })

  describe('buildDocsManifest', () => {
    it('lists student pages in curated order, excluding the landing index', () => {
      const { pages } = buildDocsManifest(docsDir)
      // Curated first (getting-started, environments, agent-interface, submitting), then the rest
      // alphabetically; students/index.md is the landing and never appears as a nav page.
      expect(pages.map((p) => p.path)).toEqual([
        'students/getting-started.md',
        'students/environments/index.md',
        'students/agent-interface.md',
        'students/submitting.md',
        'students/fenced-only.md',
      ])
    })

    it('titles each page from its first H1', () => {
      const { pages } = buildDocsManifest(docsDir)
      expect(pages.find((p) => p.path === 'students/getting-started.md')?.title).toBe(
        'Getting Started',
      )
    })

    it('nests a directory as a section landing on its index, children ordered', () => {
      const section = buildDocsManifest(docsDir).pages.find(
        (p) => p.path === 'students/environments/index.md',
      )
      expect(section?.title).toBe('Environments')
      expect(section?.children?.map((c) => c.path)).toEqual([
        'students/environments/flappy-bird.md',
        'students/environments/hearts.md',
        'students/environments/spades.md',
      ])
    })

    it('ignores a `#` inside a code fence and falls back to a humanized filename', () => {
      const page = buildDocsManifest(docsDir).pages.find(
        (p) => p.path === 'students/fenced-only.md',
      )
      // The only `#` line lives in a fenced block, so it is not the title; the filename humanizes.
      expect(page?.title).toBe('Fenced only')
    })

    it('returns no pages when the students tree is absent', () => {
      const empty = mkdtempSync(join(tmpdir(), 'gs-docs-empty-'))
      try {
        expect(buildDocsManifest(empty)).toEqual({ pages: [] })
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    })
  })

  describe('readDocsPage', () => {
    it('returns the raw markdown for a flat and a nested page', () => {
      expect(readDocsPage(docsDir, 'students/getting-started.md')?.content).toContain(
        '# Getting Started',
      )
      const nested = readDocsPage(docsDir, 'students/environments/hearts.md')
      expect(nested?.path).toBe('students/environments/hearts.md')
      expect(nested?.content).toContain('# Hearts')
    })

    it('rejects traversal, absolute, non-markdown, and out-of-scope paths', () => {
      expect(readDocsPage(docsDir, 'students/../contributors/secret.md')).toBeNull()
      expect(readDocsPage(docsDir, 'students/..\\contributors\\secret.md')).toBeNull()
      expect(readDocsPage(docsDir, '/etc/passwd')).toBeNull()
      expect(readDocsPage(docsDir, 'students/getting-started.txt')).toBeNull()
      expect(readDocsPage(docsDir, 'contributors/secret.md')).toBeNull()
      // A well-formed but non-existent page is a miss, not a throw.
      expect(readDocsPage(docsDir, 'students/nope.md')).toBeNull()
    })
  })

  describe('readDocsIndex', () => {
    it('serves the students index by default', () => {
      const index = readDocsIndex(docsDir)
      expect(index.path).toBe('students/index.md')
      expect(index.content).toContain('# For Students')
    })

    it('serves an override file but keeps the students-index path for link resolution', () => {
      const overrideFile = join(docsDir, 'class-home.md')
      writeFileSync(overrideFile, '# Fall 2026\n\nWelcome to the class.\n')
      const index = readDocsIndex(docsDir, overrideFile)
      expect(index.content).toContain('# Fall 2026')
      // The path stays students/index.md so relative links in the override resolve as the default would.
      expect(index.path).toBe('students/index.md')
    })

    it('throws DocsIndexError when a configured override cannot be read', () => {
      expect(() => readDocsIndex(docsDir, join(docsDir, 'missing.md'))).toThrow(DocsIndexError)
    })
  })
})

describe('docs HTTP routes', () => {
  let app: FastifyInstance
  let storage: Storage
  let auth: Auth
  let orchestrator: Orchestrator
  let docsDir: string
  let dataDir: string

  async function buildDocsApp(docsIndexFile?: string): Promise<FastifyInstance> {
    const config = makeConfig({ docsDir })
    orchestrator = new Orchestrator(new FakeDriver(), storage, makeEnvironments(), config)
    const recordings = new RecordingsStore(dataDir)
    return buildApp({
      orchestrator,
      environments: makeEnvironments(),
      recordings,
      retention: new Retention(storage, recordings, config),
      auth,
      docsIndexFile,
      ...makeSubmissionDeps(storage, config),
    })
  }

  beforeEach(async () => {
    docsDir = writeFixtureDocs()
    dataDir = mkdtempSync(join(tmpdir(), 'gs-docs-data-'))
    const stack = await openTestStack()
    storage = stack.storage
    auth = stack.auth
    app = await buildDocsApp()
  })

  afterEach(async () => {
    await orchestrator.shutdown()
    await app.close()
    await storage.close()
    rmSync(docsDir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('serves the navigation manifest', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs/manifest' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { pages: Array<{ path: string }> }
    expect(body.pages[0]?.path).toBe('students/getting-started.md')
  })

  it('serves the default landing page', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs/index' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { path: string; content: string }
    expect(body.path).toBe('students/index.md')
    expect(body.content).toContain('# For Students')
  })

  it('serves a page by its docs-relative path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/docs/pages/students/environments/spades.md',
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { content: string }).content).toContain('# Spades')
  })

  it('returns a JSON 404 for an unknown page', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs/pages/students/nope.md' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('rejects a percent-encoded traversal through the page route', async () => {
    // Fastify decodes the wildcard param, so `%2e%2e` reaches the handler as `..`; the segment check
    // and the resolved-path boundary check keep the out-of-scope contributors file unreachable.
    const res = await app.inject({
      method: 'GET',
      url: '/api/docs/pages/students/%2e%2e/contributors/secret.md',
    })
    expect(res.statusCode).toBe(404)
  })

  it('serves a configured class-index override at the landing route', async () => {
    const overrideFile = join(docsDir, 'class-home.md')
    writeFileSync(overrideFile, '# Fall 2026\n\nWelcome.\n')
    await app.close()
    app = await buildDocsApp(overrideFile)
    const res = await app.inject({ method: 'GET', url: '/api/docs/index' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { content: string }).content).toContain('# Fall 2026')
  })

  it('returns 500 when a configured override is unreadable', async () => {
    await app.close()
    app = await buildDocsApp(join(docsDir, 'missing.md'))
    const res = await app.inject({ method: 'GET', url: '/api/docs/index' })
    expect(res.statusCode).toBe(500)
    expect((res.json() as { error: string }).error).toContain('DOCS_INDEX_FILE')
  })
})
