import { defineConfig } from 'vitest/config'

// The Docker-gated integration suite. It is a separate project from the unit config so it never
// runs in the default `vitest run`: it needs a reachable Docker daemon and builds the session base
// image once in globalSetup. Run it with `npm run test:integration` (CI: the backend-integration
// job). Containers are shared host state, so the files run serially with long timeouts.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    pool: 'forks',
  },
})
