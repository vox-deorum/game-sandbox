/**
 * The thin rasterizer: it walks a {@link Scene}'s shapes and HUD and draws them into a 2D canvas
 * context. All the logic lives in `computeScene`; this is deliberately trivial (a switch over shape
 * kinds) so it needs no unit test of its own — actual pixels are the end-to-end suite's job, and jsdom
 * has no canvas to rasterize against anyway.
 */
import { COLORS, type Scene } from './scene.js'

/** Paint a scene into the context, clearing first. The caller sizes the canvas to the scene. */
export function paint(ctx: CanvasRenderingContext2D, scene: Scene): void {
  ctx.clearRect(0, 0, scene.width, scene.height)

  for (const shape of scene.shapes) {
    if (shape.kind === 'rect') {
      ctx.fillStyle = shape.fill
      ctx.fillRect(shape.x, shape.y, shape.w, shape.h)
      continue
    }
    // The bird: a rotated body with a small beak and eye, drawn around its center.
    ctx.save()
    ctx.translate(shape.x, shape.y)
    ctx.rotate((shape.rot * Math.PI) / 180)
    ctx.fillStyle = shape.fill
    ctx.strokeStyle = shape.edge
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.ellipse(0, 0, shape.radius * 1.2, shape.radius, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // Beak.
    ctx.fillStyle = '#e8772e'
    ctx.beginPath()
    ctx.moveTo(shape.radius * 1.1, -2)
    ctx.lineTo(shape.radius * 1.7, 0)
    ctx.lineTo(shape.radius * 1.1, 4)
    ctx.closePath()
    ctx.fill()
    // Eye.
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(shape.radius * 0.4, -shape.radius * 0.4, shape.radius * 0.35, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#222222'
    ctx.beginPath()
    ctx.arc(shape.radius * 0.5, -shape.radius * 0.4, shape.radius * 0.15, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  for (const text of scene.hud) {
    ctx.textAlign = text.align
    ctx.textBaseline = 'middle'
    ctx.font = `bold ${text.size}px system-ui, sans-serif`
    // A soft shadow so the white HUD stays legible over the sky and pipes.
    ctx.fillStyle = COLORS.hudShadow
    ctx.fillText(text.text, text.x + 1, text.y + 1)
    ctx.fillStyle = text.fill
    ctx.fillText(text.text, text.x, text.y)
  }
}
