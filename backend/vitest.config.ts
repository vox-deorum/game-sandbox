import { defineConfig } from 'vitest/config'

// The unit suite runs everywhere with no Docker. The Docker-gated integration project is a
// separate config (test/integration/) wired in Stage 3's testing step so it can be selected
// explicitly in CI and skipped on machines without a daemon.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
  },
})
