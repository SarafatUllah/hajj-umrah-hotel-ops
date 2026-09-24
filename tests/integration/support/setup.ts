import { requireTestDatabaseUrl } from './testDatabase'

// Runs before every integration test file (see vitest.integration.config.ts).
requireTestDatabaseUrl()
