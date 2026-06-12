// Extends Vitest's `expect` with the jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...)
// used by the component suites. Loaded once before any test through vitest.config's setupFiles.
import '@testing-library/jest-dom/vitest'
