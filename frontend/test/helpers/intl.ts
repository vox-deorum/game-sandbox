import { afterEach, beforeEach, vi } from 'vitest'

/**
 * Pin `Intl.DateTimeFormat` to the en-US locale and the UTC time zone for the enclosing suite, so
 * date and time formatters that follow the viewer's locale produce the same text on every machine.
 * A formatter that names its own locale or time zone keeps it.
 */
export function useFixedDateTimeFormat(): void {
  const NativeDateTimeFormat = Intl.DateTimeFormat

  beforeEach(() => {
    class FixedDateTimeFormat extends NativeDateTimeFormat {
      constructor(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
        super(locales ?? 'en-US', { ...options, timeZone: options?.timeZone ?? 'UTC' })
      }
    }
    vi.stubGlobal(
      'Intl',
      new Proxy(Intl, {
        get(target, property, receiver) {
          return property === 'DateTimeFormat'
            ? FixedDateTimeFormat
            : Reflect.get(target, property, receiver)
        },
      }),
    )
  })

  afterEach(() => vi.unstubAllGlobals())
}
