import { fileURLToPath, pathToFileURL } from 'node:url'

import type { AtlasPageSpec } from './atlas.js'
import { checkAtlasPage, packAtlasPage, splitAtlasPage } from './atlas-io.js'

type AtlasCommand = 'split' | 'pack' | 'check'

/** Run the atlas command for one environment and, optionally, one catalog group. */
export async function runAtlasCli(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const [command, environment, group, ...extra] = arguments_
  if (!isAtlasCommand(command) || environment === undefined || extra.length > 0) {
    throw new Error('Usage: atlas split|pack|check <environment> [group]')
  }
  const moduleUrl = environmentModuleUrl(environment)
  const module = (await import(moduleUrl.href)) as { ATLAS_PAGES?: readonly AtlasPageSpec[] }
  if (module.ATLAS_PAGES === undefined) {
    throw new Error(`Environment ${environment} does not export ATLAS_PAGES`)
  }
  const pages =
    group === undefined
      ? module.ATLAS_PAGES
      : module.ATLAS_PAGES.filter((page) => page.group === group)
  if (pages.length === 0) throw new Error(`Environment ${environment} has no ${group} atlas pages`)

  const rendererDirectory = fileURLToPath(new URL('.', moduleUrl))
  for (const page of pages) {
    if (command === 'split') {
      await splitAtlasPage(rendererDirectory, page)
    } else if (command === 'pack') {
      await packAtlasPage(rendererDirectory, page)
    } else {
      await checkAtlasPage(rendererDirectory, page)
    }
  }
}

function isAtlasCommand(value: string | undefined): value is AtlasCommand {
  return value === 'split' || value === 'pack' || value === 'check'
}

/** Resolve one environment's renderer manifest without allowing path traversal. */
export function environmentModuleUrl(environment: string): URL {
  if (!/^[A-Za-z0-9_-]+$/.test(environment)) {
    throw new Error(`Environment must be one directory name: ${environment}`)
  }
  return new URL(`../../../../../environments/${environment}/renderer/assets.ts`, import.meta.url)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await runAtlasCli()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exitCode = 1
  }
}
