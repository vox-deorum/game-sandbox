import { describe, expect, it } from 'vitest'

import {
  composeWindow,
  EMOTE_TOKENS,
  expressionActionId,
  hotkeyExpression,
  isTextEntry,
  JOYSTICK_DEAD_ZONE,
  JOYSTICK_RADIUS,
  JOYSTICK_SPEED_DEAD_ZONE,
  joystickMotion,
  keyboardMotion,
  motionKey,
  wrapDegrees,
} from './input.js'

const CENTER = { x: 300, y: 500 }

describe('Three Branches input composition', () => {
  it('pins the ruleset emote order the hotkeys and action ids build on', () => {
    expect(EMOTE_TOKENS).toEqual([
      'wave',
      'nod',
      'shake_head',
      'point',
      'laugh',
      'shrug',
      'startle',
      'sleep',
      'sweep',
    ])
  })

  describe('joystickMotion', () => {
    it('reads no motion inside the dead zone', () => {
      const inside = JOYSTICK_RADIUS * JOYSTICK_DEAD_ZONE
      expect(joystickMotion(CENTER, CENTER)).toBeNull()
      expect(joystickMotion(CENTER, { x: CENTER.x + inside, y: CENTER.y })).toBeNull()
    })

    it('converts an upward screen drag into a north heading', () => {
      const motion = joystickMotion(CENTER, { x: CENTER.x, y: CENTER.y - JOYSTICK_RADIUS })
      expect(motion?.heading).toBeCloseTo(90)
      expect(motion?.speed).toBeCloseTo(1)
    })

    it('converts a down-left drag into a southwest heading', () => {
      const motion = joystickMotion(CENTER, { x: CENTER.x - 50, y: CENTER.y + 50 })
      expect(motion?.heading).toBeCloseTo(225)
    })

    it('rises linearly from the dead zone edge to the pad ring', () => {
      const halfway = JOYSTICK_RADIUS * (JOYSTICK_DEAD_ZONE + (1 - JOYSTICK_DEAD_ZONE) / 2)
      const motion = joystickMotion(CENTER, { x: CENTER.x + halfway, y: CENTER.y })
      expect(motion?.heading).toBeCloseTo(0)
      expect(motion?.speed).toBeCloseTo(0.5)
    })

    it('saturates at full speed beyond the pad ring', () => {
      const motion = joystickMotion(CENTER, { x: CENTER.x, y: CENTER.y + JOYSTICK_RADIUS * 4 })
      expect(motion?.heading).toBeCloseTo(270)
      expect(motion?.speed).toBe(1)
    })

    it('reads a barely-past-the-dead-zone crawl as no motion', () => {
      const crawl = JOYSTICK_RADIUS * (JOYSTICK_DEAD_ZONE + 0.01)
      // Speed rises 0.01 / (1 - dead zone) past the edge, far below the low-speed clamp.
      expect(joystickMotion(CENTER, { x: CENTER.x + crawl, y: CENTER.y })).toBeNull()
    })

    it('honors a clamp above the default and keeps a clamp-equivalent drag', () => {
      const crawl = JOYSTICK_RADIUS * (JOYSTICK_DEAD_ZONE + JOYSTICK_SPEED_DEAD_ZONE)
      const point = { x: CENTER.x + crawl, y: CENTER.y }
      // Speed 0.05 / 0.85 sits just above the default 0.05 clamp, so the default must keep it and
      // a higher clamp must drop it.
      expect(joystickMotion(CENTER, point)).not.toBeNull()
      expect(joystickMotion(CENTER, point, JOYSTICK_RADIUS, 0.1)).toBeNull()
    })
  })

  describe('keyboardMotion', () => {
    it('reads the eight ways at full speed', () => {
      expect(keyboardMotion(new Set(['KeyD']))?.heading).toBeCloseTo(0)
      expect(keyboardMotion(new Set(['KeyW', 'KeyD']))?.heading).toBeCloseTo(45)
      expect(keyboardMotion(new Set(['ArrowUp']))?.heading).toBeCloseTo(90)
      expect(keyboardMotion(new Set(['KeyW', 'ArrowLeft']))?.heading).toBeCloseTo(135)
      expect(keyboardMotion(new Set(['KeyA']))?.heading).toBeCloseTo(180)
      expect(keyboardMotion(new Set(['KeyS', 'KeyA']))?.heading).toBeCloseTo(225)
      expect(keyboardMotion(new Set(['ArrowDown']))?.heading).toBeCloseTo(270)
      expect(keyboardMotion(new Set(['KeyS', 'KeyD']))?.heading).toBeCloseTo(315)
      expect(keyboardMotion(new Set(['KeyW']))?.speed).toBe(1)
    })

    it('halves the speed while Shift is held', () => {
      expect(keyboardMotion(new Set(['KeyW', 'ShiftLeft']))?.speed).toBe(0.5)
      expect(keyboardMotion(new Set(['ArrowRight', 'ShiftRight']))?.speed).toBe(0.5)
    })

    it('cancels opposing keys per axis', () => {
      expect(keyboardMotion(new Set(['KeyW', 'KeyS', 'KeyD']))?.heading).toBeCloseTo(0)
      expect(keyboardMotion(new Set(['KeyA', 'KeyD', 'ArrowUp']))?.heading).toBeCloseTo(90)
    })

    it('yields no heading when both axes cancel or nothing is held', () => {
      expect(keyboardMotion(new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD']))).toBeNull()
      expect(keyboardMotion(new Set())).toBeNull()
      expect(keyboardMotion(new Set(['ShiftLeft']))).toBeNull()
    })
  })

  describe('motionKey', () => {
    it('rounds the heading to 10 and the speed to 100', () => {
      expect(motionKey({ heading: 91.6, speed: 0.333 })).toBe('91.6,0.33')
      expect(motionKey({ heading: 90, speed: 1 })).toBe('90,1')
    })
  })

  describe('composeWindow', () => {
    it('lets an engaged joystick win over held keys', () => {
      const action = composeWindow({
        joystickEngaged: true,
        joystickMotion: { heading: 90, speed: 1 },
        heldKeys: new Set(['KeyS']),
        queuedAction: 0,
        currentHeading: 10,
      })
      expect(action).toEqual({ heading: 90, speed: 1, action: 0 })
    })

    it('keeps keys out while an engaged joystick sits in its dead zone', () => {
      const action = composeWindow({
        joystickEngaged: true,
        joystickMotion: null,
        heldKeys: new Set(['KeyS']),
        queuedAction: 0,
        currentHeading: 10,
      })
      expect(action).toBeNull()
    })

    it('applies held keys when no joystick is engaged', () => {
      const action = composeWindow({
        joystickEngaged: false,
        joystickMotion: null,
        heldKeys: new Set(['KeyD']),
        queuedAction: 0,
        currentHeading: 10,
      })
      expect(action).toEqual({ heading: 0, speed: 1, action: 0 })
    })

    it('skips the default window entirely, matching the harness fallback', () => {
      const action = composeWindow({
        joystickEngaged: false,
        joystickMotion: null,
        heldKeys: new Set(),
        queuedAction: 0,
        currentHeading: 123.4,
      })
      expect(action).toBeNull()
    })

    it('sends a queued expression standing still at the current heading', () => {
      const action = composeWindow({
        joystickEngaged: false,
        joystickMotion: null,
        heldKeys: new Set(),
        queuedAction: 2,
        currentHeading: 123.4,
      })
      expect(action).toEqual({ heading: 123.4, speed: 0, action: 2 })
    })

    it('rides a queued expression on the composed motion', () => {
      const action = composeWindow({
        joystickEngaged: false,
        joystickMotion: null,
        heldKeys: new Set(['ArrowDown']),
        queuedAction: 10,
        currentHeading: 0,
      })
      expect(action).toEqual({ heading: 270, speed: 1, action: 10 })
    })
  })

  describe('expression tokens', () => {
    it('maps use to 1 and the emotes to their pinned ids', () => {
      expect(expressionActionId('use')).toBe(1)
      expect(expressionActionId('wave')).toBe(2)
      expect(expressionActionId('shake_head')).toBe(4)
      expect(expressionActionId('sweep')).toBe(10)
      expect(expressionActionId('unknown')).toBe(0)
    })

    it('maps digits 1 through 9 to emotes and 0 to use', () => {
      expect(hotkeyExpression('Digit1')).toBe('wave')
      expect(hotkeyExpression('Digit3')).toBe('shake_head')
      expect(hotkeyExpression('Digit9')).toBe('sweep')
      expect(hotkeyExpression('Digit0')).toBe('use')
      expect(hotkeyExpression('KeyX')).toBeNull()
      expect(hotkeyExpression('Numpad1')).toBeNull()
    })
  })

  describe('wrapDegrees', () => {
    it('normalizes into [0, 360)', () => {
      expect(wrapDegrees(360)).toBe(0)
      expect(wrapDegrees(-90)).toBe(270)
      expect(wrapDegrees(45)).toBe(45)
    })
  })

  describe('isTextEntry', () => {
    it('recognizes typing targets and passes everything else', () => {
      expect(isTextEntry(document.createElement('input'))).toBe(true)
      expect(isTextEntry(document.createElement('textarea'))).toBe(true)
      expect(isTextEntry(document.createElement('div'))).toBe(false)
      expect(isTextEntry(null)).toBe(false)
    })
  })
})
