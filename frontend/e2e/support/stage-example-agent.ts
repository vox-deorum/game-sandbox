import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const COMPOSE_SCRIPT = join(REPO_ROOT, 'scripts', 'compose.py')

/**
 * Stage an example agent through the same composition path that builds published example branches.
 * Callers own removal of the returned temporary directory.
 */
export function stageExampleAgent(environmentId: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${environmentId}-${name}-`))
  try {
    execFileSync('uv', ['run', 'python', COMPOSE_SCRIPT, environmentId, name, '--out', dir], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    })
    return dir
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
