/**
 * Renderer registration barrel. Importing this once (from `main.ts`) is what pulls every
 * environment's renderer module in so it can register itself with the registry. Each future
 * environment adds one line here, mapping its metadata `renderer` key to its module.
 */
import { flappyBirdRenderer } from './flappy-bird/index.js'
import { registerRenderer } from './registry.js'

registerRenderer('flappy-bird', flappyBirdRenderer)
