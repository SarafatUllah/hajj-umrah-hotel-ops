import { config } from 'dotenv'

/**
 * Loads environment variables for the database CLIs (migrate, drift check, drizzle-kit). Variables
 * already set in the process win (CI, `dotenv run -f .env.test -- …`); otherwise a local
 * `packages/db/.env` is read, falling back to the API app's `.env` (the one developers already have),
 * resolved relative to this file so it works from any working directory.
 */
export function loadDbEnv(): void {
  config({ path: [new URL('.env', import.meta.url).pathname, new URL('../../apps/api/.env', import.meta.url).pathname], quiet: true })
}
