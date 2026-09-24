import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    // Refuses to run unless DATABASE_URL names a *_test database.
    setupFiles: ['tests/integration/support/setup.ts'],
  },
})
