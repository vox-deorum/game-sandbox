import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openTestApp, type TestApp } from './support/harness.js'

// A built bundle is a tiny stand-in for `frontend/dist`: an index.html and one hashed asset, enough
// to prove the backend serves files, falls back to index.html for client routes, and leaves /api alone.
const INDEX_HTML =
  '<!doctype html><html><body><div id="app"></div>built-bundle-marker</body></html>'
const ASSET_JS = 'console.log("bundle asset")'

describe('serving the built frontend', () => {
  let app: FastifyInstance
  let fixture: TestApp
  let frontendDir: string

  beforeEach(async () => {
    frontendDir = mkdtempSync(join(tmpdir(), 'gs-dist-'))
    writeFileSync(join(frontendDir, 'index.html'), INDEX_HTML)
    mkdirSync(join(frontendDir, 'assets'))
    writeFileSync(join(frontendDir, 'assets', 'app.js'), ASSET_JS)

    fixture = await openTestApp({ frontendDir })
    app = fixture.app
  })

  afterEach(async () => {
    await fixture.close()
    rmSync(frontendDir, { recursive: true, force: true })
  })

  it('serves index.html at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('built-bundle-marker')
  })

  it('serves index.html verbatim without an analytics id', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.body).not.toContain('googletagmanager.com')
  })

  it('serves a hashed asset by its path', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('bundle asset')
  })

  it('falls back to index.html for a client-side route (SPA deep link)', async () => {
    const res = await app.inject({ method: 'GET', url: '/environments/flappy_bird' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('built-bundle-marker')
  })

  it('still serves the API instead of the SPA under /api', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/environments' })
    expect(res.statusCode).toBe(200)
    const envs = res.json() as Array<{ env_id: string }>
    expect(envs.map((e) => e.env_id)).toContain('flappy_bird')
  })

  it('keeps a JSON 404 for an unknown API route rather than the SPA', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.body).not.toContain('built-bundle-marker')
  })
})

describe('serving the built frontend with Google Analytics', () => {
  let app: FastifyInstance
  let fixture: TestApp
  let frontendDir: string

  beforeEach(async () => {
    frontendDir = mkdtempSync(join(tmpdir(), 'gs-dist-'))
    writeFileSync(join(frontendDir, 'index.html'), INDEX_HTML)
    mkdirSync(join(frontendDir, 'assets'))
    writeFileSync(join(frontendDir, 'assets', 'app.js'), ASSET_JS)

    fixture = await openTestApp({ frontendDir, googleAnalyticsId: 'G-G98YR1FFWX' })
    app = fixture.app
  })

  afterEach(async () => {
    await fixture.close()
    rmSync(frontendDir, { recursive: true, force: true })
  })

  it.each([
    '/',
    '/index.html',
    '/environments/flappy_bird',
  ])('injects the gtag loader into the %s page', async (url) => {
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('https://www.googletagmanager.com/gtag/js?id=G-G98YR1FFWX')
    expect(res.body).toContain("gtag('config', 'G-G98YR1FFWX');")
    expect(res.body).toContain('built-bundle-marker')
  })

  it('leaves hashed assets unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(ASSET_JS)
    expect(res.body).not.toContain('googletagmanager.com')
  })
})
