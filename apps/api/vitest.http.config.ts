import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/http/**/*.test.ts'],
    environment: 'node',
    // One shared built server + one shared DB connection per test file (see
    // tests/http/support/fixtures.ts): tests mutate the database directly
    // (that is the whole point of proving freshness), so files run
    // sequentially to keep those mutations from crossing test files.
    fileParallelism: false,
    globalSetup: ['tests/http/support/globalSetup.ts'],
    // The build + server boot + full suite can legitimately take longer than
    // vitest's default 5s per-hook timeout.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
})
