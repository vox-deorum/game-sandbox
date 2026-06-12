import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// The unit suite runs in jsdom with no canvas and no network: scene/transport logic, the socket
// client, the identity and API wrappers, and the component-shaped pages through Testing Library.
// Real pixels and a real session are the end-to-end suite's job (see testing-ci-and-docs.md).
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
