import { copyFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TEMPLATE_VERSION } from './template-version.js'

const MANIFEST = `${JSON.stringify(
  { entry_point: 'agent', class_name: 'Agent', template_version: TEMPLATE_VERSION },
  null,
  2,
)}\n`

/** Prune Python bytecode caches while copying: their `.pyc` files never belong in a submission. */
function withoutPycache(source: string): boolean {
  return !/[\\/]__pycache__(?:[\\/]|$)/.test(source)
}

function withoutGeneratedEnvironment(source: string): boolean {
  return withoutPycache(source) && !/[\\/]sandbox[\\/]env(?:[\\/]|$)/.test(source)
}

/**
 * Stage an example agent as a local submission with its composed sandbox and generated manifest.
 * Callers own removal of the returned temporary directory.
 */
export function stageExampleAgent(environmentId: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${environmentId}-${name}-`))
  const baseSandbox = fileURLToPath(new URL('../../../templates/base/sandbox', import.meta.url))
  const harnessSource = fileURLToPath(
    new URL('../../../harness/src/game_sandbox_harness', import.meta.url),
  )
  const localPlay = fileURLToPath(new URL('../../../environments/local_play', import.meta.url))
  const environmentSandbox = fileURLToPath(
    new URL(`../../../environments/${environmentId}/template/sandbox`, import.meta.url),
  )
  const source = fileURLToPath(
    new URL(`../../../environments/${environmentId}/examples/${name}/agent.py`, import.meta.url),
  )

  cpSync(baseSandbox, join(dir, 'sandbox'), { recursive: true, filter: withoutPycache })
  cpSync(harnessSource, join(dir, 'sandbox', 'harness'), {
    recursive: true,
    filter: withoutPycache,
  })
  for (const helper of [
    'card_utils.py',
    'card_spaces.py',
    'shared_modules.py',
    'semantic_cards.py',
  ]) {
    copyFileSync(join(localPlay, helper), join(dir, 'sandbox', helper))
  }
  // Example agents currently use only sandbox helpers, never sandbox.env. Extend this staging recipe
  // if an example needs to import sandbox.env.
  cpSync(environmentSandbox, join(dir, 'sandbox'), {
    recursive: true,
    force: true,
    filter: withoutGeneratedEnvironment,
  })
  copyFileSync(source, join(dir, 'agent.py'))
  writeFileSync(join(dir, 'manifest.json'), MANIFEST)
  return dir
}
