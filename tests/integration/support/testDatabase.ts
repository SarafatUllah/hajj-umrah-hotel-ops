/**
 * Returns DATABASE_URL after verifying it points at a database whose name
 * ends in `_test`. Integration tests TRUNCATE tables freely; this guard
 * makes a misconfigured DATABASE_URL (e.g. the dev database) fail loudly
 * before a single statement runs instead of silently wiping real data.
 *
 * Called from the vitest setup file (so every integration test file is
 * covered, including future ones) and by each test file when it builds its
 * own client.
 */
export function requireTestDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL must be set (run via `dotenv run -f .env.test --`, e.g. `pnpm test:integration`)')
  }

  let databaseName: string
  try {
    databaseName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''))
  }
  catch {
    throw new Error('DATABASE_URL is not a parseable connection URL; refusing to run destructive integration tests')
  }

  if (!databaseName.endsWith('_test')) {
    throw new Error(`Refusing to run integration tests against database "${databaseName}": the database name must end in "_test"`)
  }

  return connectionString
}
