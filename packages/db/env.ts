import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

/**
 * Loads environment variables for the database CLIs (migrate, drift check, drizzle-kit). Variables
 * already set in the process win (CI, `dotenv run -f .env.test -- …`); otherwise a local
 * `packages/db/.env` is read, falling back to the API app's `apps/api/.env` (the file developers
 * already have — a deliberate development convenience, documented in docs/MIGRATIONS.md). Paths are
 * resolved relative to this file, so the CLIs work from any working directory.
 */
export function loadDbEnv(): void {
  config({
    path: [fileURLToPath(new URL('.env', import.meta.url)), fileURLToPath(new URL('../../apps/api/.env', import.meta.url))],
    quiet: true,
  })
}
