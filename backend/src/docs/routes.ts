import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'

import { REPO_ROOT } from '../config/env-files.js'
import { buildDocsManifest, DocsIndexError, readDocsIndex, readDocsPage } from './docs.js'

const DEFAULT_DOCS_DIR = join(REPO_ROOT, 'docs')
const DEFAULT_ENVIRONMENTS_DIR = join(REPO_ROOT, 'environments')

/** The optional documentation roots and index override used by the public docs reads. */
export interface DocsRouteDeps {
  docsDir?: string
  environmentGuidesDir?: string
  docsIndexFile?: string
}

/** Register the public in-app student-guide routes. */
export function registerDocsRoutes(app: FastifyInstance, deps: DocsRouteDeps): void {
  // The in-app student guides. Read-only and unauthenticated like `/api/config`: the frontend renders
  // the markdown and rewrites links, so these routes only serve the nav tree and raw page bytes. The
  // landing honors the optional class-index override; a page fetch is path-sanitized to `students/`.
  const docsDir = deps.docsDir ?? DEFAULT_DOCS_DIR
  const environmentGuidesDir = deps.environmentGuidesDir ?? DEFAULT_ENVIRONMENTS_DIR
  app.get('/api/docs/manifest', () => buildDocsManifest(docsDir, environmentGuidesDir))

  app.get('/api/docs/index', (_request, reply) => {
    try {
      return readDocsIndex(docsDir, deps.docsIndexFile)
    } catch (error) {
      if (error instanceof DocsIndexError) {
        return reply.code(500).send({ error: error.message })
      }
      throw error
    }
  })

  app.get<{ Params: { '*': string } }>('/api/docs/pages/*', (request, reply) => {
    const page = readDocsPage(docsDir, environmentGuidesDir, request.params['*'])
    if (page === null) {
      return reply.code(404).send({ error: 'documentation page not found' })
    }
    return page
  })
}
