/**
 * Renderer registration barrel. Importing this once (from `main.ts`) is what pulls every
 * environment's renderer in so it can register itself with the registry. Renderer definitions live
 * beside their environment packages and are registered by this eager glob.
 */
import { registerRendererModules } from './registry.js'
import type { RendererDefinition } from './types.js'

const modules = import.meta.glob<{ default: RendererDefinition }>(
  '../../../environments/*/renderer/index.ts',
  { eager: true },
)

registerRendererModules(modules)
