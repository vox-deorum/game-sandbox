import { fileURLToPath, pathToFileURL } from 'node:url'

import type { AtlasBuildPageSpec } from './atlas.js'
import { buildAtlasPage, checkAtlasPage, selectAtlasPages } from './atlas-io.js'

type AtlasCommand = 'build' | 'check'

/** Run the atlas compiler for one environment and, optionally, one group or page key. */
export async function runAtlasCli(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const [command, environment, selector, ...extra] = arguments_
  if (!isAtlasCommand(command) || environment === undefined || extra.length > 0)
    throw new Error('Usage: atlas build|check <environment> [group-or-page]')
  const moduleUrl = environmentModuleUrl(environment)
  const module = (await import(moduleUrl.href)) as { ATLAS_PAGES?: readonly AtlasBuildPageSpec[] }
  if (module.ATLAS_PAGES === undefined)
    throw new Error(`Environment ${environment} does not export ATLAS_PAGES`)
  const pages = selectAtlasPages(module.ATLAS_PAGES, selector)
  if (pages.length === 0)
    throw new Error(`Environment ${environment} has no ${selector} atlas pages`)
  const rendererDirectory = fileURLToPath(new URL('.', moduleUrl))
  for (const page of pages) {
    if (command === 'build') await buildAtlasPage(rendererDirectory, page)
    else await checkAtlasPage(rendererDirectory, page)
  }
}

function isAtlasCommand(value: string | undefined): value is AtlasCommand {
  return value === 'build' || value === 'check'
}

/** Resolve one environment's renderer manifest without allowing path traversal. */
export function environmentModuleUrl(environment: string): URL {
  if (!/^[A-Za-z0-9_-]+$/.test(environment))
    throw new Error(`Environment must be one directory name: ${environment}`)
  return new URL(`../../../../../environments/${environment}/renderer/assets.ts`, import.meta.url)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await runAtlasCli()
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
