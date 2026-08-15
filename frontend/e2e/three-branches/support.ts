import type { Locator } from '@playwright/test'

/** Constants and helpers shared by the Three Branches browser journeys. */

export const ENV_ID = 'three_branches'

/** The renderer's fixed logical drawing surface. */
export const INTERNAL_SIZE = { width: 1_200, height: 1_000 }

/**
 * The browser point at the centre of a renderer control, read from the rectangle the renderer
 * publishes for it. The renderer answers its controls in its own logical coordinates, so the
 * journeys convert through the canvas box rather than hunting for a DOM element that does not
 * exist. Works for the chrome strip buttons and the expression palette plates alike.
 */
export async function controlCentre(
  host: Locator,
  probe: string,
  canvasBox: { x: number; y: number; width: number; height: number },
): Promise<{ x: number; y: number }> {
  const rect = (await host.getAttribute(probe))?.split(',').map(Number)
  if (rect === undefined || rect.length !== 4 || rect.some((value) => !Number.isFinite(value))) {
    throw new Error(`Three Branches control probe ${probe} is invalid`)
  }
  const [x, y, width, height] = rect
  return {
    x: canvasBox.x + ((x + width / 2) / INTERNAL_SIZE.width) * canvasBox.width,
    y: canvasBox.y + ((y + height / 2) / INTERNAL_SIZE.height) * canvasBox.height,
  }
}
