/**
 * Pure input composition for the human-controlled visitor.
 *
 * Headings are environment degrees counterclockwise from east in the north-up village frame. The
 * screen draws y downward, so converting a screen drag into a heading negates the vertical delta:
 * dragging up on screen reads as north, which moves the character up on screen.
 */
import { RULES } from './overlay.js'

/** The environment's emote tokens in ruleset order. Grid position i carries hotkey i + 1. */
export const EMOTE_TOKENS: readonly string[] = RULES.emotes

/** Logical view radius of the floating pad ring, where drag speed saturates at full. */
export const JOYSTICK_RADIUS = 70

/** Fraction of the pad ring below which a drag reads as no movement. */
export const JOYSTICK_DEAD_ZONE = 0.15

/** Keyboard codes that steer the visitor, per compass direction. */
const NORTH_KEYS = ['KeyW', 'ArrowUp'] as const
const SOUTH_KEYS = ['KeyS', 'ArrowDown'] as const
const WEST_KEYS = ['KeyA', 'ArrowLeft'] as const
const EAST_KEYS = ['KeyD', 'ArrowRight'] as const

/** Every keyboard code the movement axes read. */
export const MOVEMENT_KEY_CODES: ReadonlySet<string> = new Set([
  ...NORTH_KEYS,
  ...SOUTH_KEYS,
  ...WEST_KEYS,
  ...EAST_KEYS,
])

/** The modifier codes that halve keyboard speed while held. */
export const SHIFT_KEY_CODES: ReadonlySet<string> = new Set(['ShiftLeft', 'ShiftRight'])

/** A live movement reading from one device. */
export interface MotionInput {
  /** Environment heading in degrees counterclockwise from east. */
  heading: number
  /** Relative speed between 0 and 1. */
  speed: number
}

/** One composed action in the environment's visitor action space. */
export interface VisitorAction {
  heading: number
  speed: number
  action: number
}

/** Normalize any degree value into the environment's [0, 360) range. */
export function wrapDegrees(value: number): number {
  if (value >= 0 && value < 360) return value
  return ((value % 360) + 360) % 360
}

/**
 * Read a pad drag as motion, or null while the drag sits inside the dead zone.
 *
 * Speed rises linearly from zero at the dead-zone edge to full at the pad ring and saturates
 * beyond it. The heading converts the screen-space drag into environment degrees.
 */
export function joystickMotion(
  center: { x: number; y: number },
  point: { x: number; y: number },
  radius = JOYSTICK_RADIUS,
): MotionInput | null {
  const dx = point.x - center.x
  const dy = point.y - center.y
  const reach = Math.hypot(dx, dy) / radius
  if (reach <= JOYSTICK_DEAD_ZONE) return null
  return {
    heading: wrapDegrees((Math.atan2(-dy, dx) * 180) / Math.PI),
    speed: Math.min((reach - JOYSTICK_DEAD_ZONE) / (1 - JOYSTICK_DEAD_ZONE), 1),
  }
}

/**
 * Read the held keys as eight-way motion, or null when no direction survives.
 *
 * Opposing keys cancel on their axis, and cancelling both axes yields no keyboard heading. A held
 * Shift halves the speed.
 */
export function keyboardMotion(held: ReadonlySet<string>): MotionInput | null {
  const east = axis(held, EAST_KEYS, WEST_KEYS)
  const north = axis(held, NORTH_KEYS, SOUTH_KEYS)
  if (east === 0 && north === 0) return null
  return {
    heading: wrapDegrees((Math.atan2(north, east) * 180) / Math.PI),
    speed: shiftHeld(held) ? 0.5 : 1,
  }
}

/** Everything one composition window reads. */
export interface WindowInput {
  /** Whether a pad pointer is currently down, even inside the dead zone. */
  joystickEngaged: boolean
  /** The pad's current motion, or null inside the dead zone. */
  joystickMotion: MotionInput | null
  /** The movement and shift codes currently held. */
  heldKeys: ReadonlySet<string>
  /** The queued expression as an action id, or 0 when nothing was pressed. */
  queuedAction: number
  /** The visitor's heading on the latest landed state. */
  currentHeading: number
}

/**
 * Compose one input window: an engaged joystick wins, held keys apply otherwise, and neither
 * yields speed 0 with the current heading. Returns null when the result equals the environment
 * default and no expression is queued, because the harness already falls back to exactly that
 * action when nothing arrives.
 */
export function composeWindow(input: WindowInput): VisitorAction | null {
  const motion = input.joystickEngaged ? input.joystickMotion : keyboardMotion(input.heldKeys)
  if (motion === null && input.queuedAction === 0) return null
  return {
    heading: motion?.heading ?? wrapDegrees(input.currentHeading),
    speed: motion?.speed ?? 0,
    action: input.queuedAction,
  }
}

/** One rounded motion identity, by which eager sends recognize an unchanged reading. */
export function motionKey(motion: MotionInput): string {
  const round = (value: number, factor: number): number => Math.round(value * factor) / factor
  return `${round(motion.heading, 10)},${round(motion.speed, 100)}`
}

/** Map an expression token to its action id: use is 1 and the emotes fill 2 through 10. */
export function expressionActionId(token: string): number {
  if (token === 'use') return 1
  const index = EMOTE_TOKENS.indexOf(token)
  return index === -1 ? 0 : index + 2
}

/** Map a hotkey code to its expression token: digits 1 through 9 are emotes and 0 is use. */
export function hotkeyExpression(code: string): string | null {
  if (code === 'Digit0') return 'use'
  const match = /^Digit([1-9])$/.exec(code)
  if (match === null) return null
  return EMOTE_TOKENS[Number(match[1]) - 1] ?? null
}

/** Whether a key event landed in something the person is typing into. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

function axis(
  held: ReadonlySet<string>,
  positive: readonly string[],
  negative: readonly string[],
): number {
  const forward = positive.some((code) => held.has(code)) ? 1 : 0
  const backward = negative.some((code) => held.has(code)) ? 1 : 0
  return forward - backward
}

function shiftHeld(held: ReadonlySet<string>): boolean {
  return [...SHIFT_KEY_CODES].some((code) => held.has(code))
}
