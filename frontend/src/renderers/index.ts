/**
 * Renderer registration barrel. Importing this once (from `main.ts`) is what pulls every
 * environment's renderer module in so it can register itself with the registry. No renderer is
 * registered yet in this infrastructure step; the flappy-bird-renderer step adds its import here, and
 * each future environment adds one line.
 */
export {}
