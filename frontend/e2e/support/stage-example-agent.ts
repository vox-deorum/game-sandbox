import { copyFileSync, cpSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TEMPLATE_VERSION } from './template-version.js'

const MANIFEST = `${JSON.stringify(
  { entry_point: 'agent', class_name: 'Agent', template_version: TEMPLATE_VERSION },
  null,
  2,
)}\n`

/**
 * The modules compose copies from an environment's own package into the sandbox root, keyed by
 * environment. Keep this list equal to `env_sandbox_modules` in scripts/_envs.py: a Crane Reach agent
 * imports its observation types from there, and `sandbox/crane/units.py` imports the stat table, so a
 * submission missing either fails its load check.
 */
const ENV_SANDBOX_MODULES: Record<string, readonly string[]> = {
  flappy_bird: ['observation_types.py'],
  skirmish_crane: ['observation_types.py', 'unit_stats.py'],
}

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
  const environmentPackage = fileURLToPath(
    new URL(`../../../environments/${environmentId}`, import.meta.url),
  )
  const environmentSandbox = join(environmentPackage, 'template', 'sandbox')
  const example = join(environmentPackage, 'examples', name)

  cpSync(baseSandbox, join(dir, 'sandbox'), { recursive: true, filter: withoutPycache })
  cpSync(harnessSource, join(dir, 'sandbox', 'harness'), {
    recursive: true,
    filter: withoutPycache,
  })
  // Keep this list equal to TEMPLATE_BASE_MODULES in scripts/_paths.py, which is what compose writes
  // into a real template's sandbox. A helper missing here fails the submission at its load check.
  for (const helper of [
    'card_utils.py',
    'card_spaces.py',
    'shared_modules.py',
    'semantic_cards.py',
    'card_types.py',
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
  for (const module of ENV_SANDBOX_MODULES[environmentId] ?? []) {
    copyFileSync(join(environmentPackage, module), join(dir, 'sandbox', module))
  }
  // Everything the example owns at its own root: `agent.py`, plus any module it keeps beside it (Crane
  // Reach's banner holds its tactical blocks in `blocks.py`). Its `tests/` stay behind.
  for (const entry of readdirSync(example, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.py')) {
      copyFileSync(join(example, entry.name), join(dir, entry.name))
    }
  }
  writeFileSync(join(dir, 'manifest.json'), MANIFEST)
  return dir
}
