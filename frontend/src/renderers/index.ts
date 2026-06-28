/**
 * Renderer registration barrel. Importing this once (from `main.ts`) is what pulls every
 * environment's renderer in so it can register itself with the registry. Each future environment adds
 * one line here, mapping its metadata `renderer` key to its renderer class and home-card thumbnail.
 */
import { FlappyBirdRenderer } from './flappy-bird/index.js'
import flappyBirdThumbnail from './flappy-bird/thumbnail.svg'
import { HeartsRenderer } from './hearts/index.js'
import heartsThumbnail from './hearts/thumbnail.svg'
import { registerRenderer } from './registry.js'

registerRenderer('flappy-bird', FlappyBirdRenderer, flappyBirdThumbnail)
registerRenderer('hearts', HeartsRenderer, heartsThumbnail)
