// Extends Vitest's `expect` with the jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...)
// used by the component suites, and unmounts each rendered component between tests. Loaded once
// before any test through vitest.config's setupFiles.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/vue'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
