import { z } from 'zod'
import { DEFAULT_DEMO_ANCHOR_DATE, DEMO_ANCHOR_MAX, DEMO_ANCHOR_MIN, isValidDemoAnchorDate } from '../demo/catalog'

/** Strict boolean flag: only the literal strings `true` / `false` (anything else is a configuration error, never a silent `false`). */
const strictFlag = (name: string) => z
  .enum(['true', 'false'], { errorMap: () => ({ message: `${name} must be "true" or "false"` }) })
  .default('false')
  .transform(value => value === 'true')

const envBase = z.object({
  APP_ENV: z.enum(['development', 'demo', 'staging', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  NUXT_SESSION_PASSWORD: z.string().min(32, 'NUXT_SESSION_PASSWORD must be at least 32 characters'),
  // Task 19: where document bytes live. Only `local` exists in Phase 1 (S3-compatible is Phase 9); any
  // other value is a configuration error, never a silent fallback. The directory is resolved against
  // the process working directory.
  STORAGE_DRIVER: z.enum(['local'], { errorMap: () => ({ message: 'STORAGE_DRIVER must be "local"' }) }).default('local'),
  STORAGE_LOCAL_DIR: z.string().trim().min(1, 'STORAGE_LOCAL_DIR must not be empty').default('.data/uploads'),
  // Task 20 (demo): `ALLOW_DEMO_SEED` lets the demo seed/reset run under APP_ENV=production (never silent);
  // `DEMO_ANCHOR_DATE` is the date every time-relative demo row hangs off; `DEMO_SIGN_IN_ENABLED` switches
  // the public demo sign-in metadata endpoint on (only ever honoured under APP_ENV development/demo).
  ALLOW_DEMO_SEED: strictFlag('ALLOW_DEMO_SEED'),
  DEMO_ANCHOR_DATE: z.string().trim().refine(isValidDemoAnchorDate, { message: `DEMO_ANCHOR_DATE must be a real YYYY-MM-DD date between ${DEMO_ANCHOR_MIN} and ${DEMO_ANCHOR_MAX}` }).default(DEFAULT_DEMO_ANCHOR_DATE),
  DEMO_SIGN_IN_ENABLED: strictFlag('DEMO_SIGN_IN_ENABLED'),
})

/** APP_ENV values under which the demo sign-in endpoint may ever answer (the runtime gate below). */
export const DEMO_SIGN_IN_APP_ENVS = ['development', 'demo'] as const

/**
 * Defense in depth, layer 1 (layer 2 is the runtime gate `isDemoSignInEnabled`, layer 3 the `is_demo`
 * check on the organization): `DEMO_SIGN_IN_ENABLED=true` with `APP_ENV=production` is a configuration
 * error that stops startup. Staging with the flag on is a VALID configuration (it starts normally), but
 * the runtime gate still never serves the endpoint there — it answers like an unknown route.
 */
function refineDemoSignIn(env: { APP_ENV: string, DEMO_SIGN_IN_ENABLED: boolean }, ctx: z.RefinementCtx): void {
  if (env.DEMO_SIGN_IN_ENABLED && env.APP_ENV === 'production') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DEMO_SIGN_IN_ENABLED'], message: 'DEMO_SIGN_IN_ENABLED=true is not allowed with APP_ENV=production (the demo sign-in endpoint only ever answers under development or demo)' })
  }
}

const envSchema = envBase.superRefine(refineDemoSignIn)

export type Env = z.infer<typeof envSchema>

/** Just the storage settings, so the storage factory (and its startup check) does not depend on the database settings being valid. */
const storageEnvSchema = envBase.pick({ STORAGE_DRIVER: true, STORAGE_LOCAL_DIR: true })
export type StorageEnv = z.infer<typeof storageEnvSchema>

/** Just the demo settings (plus APP_ENV), validated together so the production sign-in rule applies. */
const demoEnvSchema = envBase.pick({ APP_ENV: true, ALLOW_DEMO_SEED: true, DEMO_ANCHOR_DATE: true, DEMO_SIGN_IN_ENABLED: true }).superRefine(refineDemoSignIn)
export type DemoEnv = z.infer<typeof demoEnvSchema>

let cachedEnv: Env | null = null

export function getEnv(): Env {
  if (cachedEnv) return cachedEnv
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new Error(`Invalid environment configuration: ${issues}`)
  }
  cachedEnv = result.data
  return cachedEnv
}

/** The validated storage settings. An unsupported `STORAGE_DRIVER` throws; there is no default for a wrong value. */
export function getStorageEnv(): StorageEnv {
  const result = storageEnvSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new Error(`Invalid environment configuration: ${issues}`)
  }
  return result.data
}

/**
 * The validated demo settings, read from `source` (default `process.env`) on EVERY call — never cached, so
 * a seed or a reset always sees the current environment. Throws on an invalid value or on the forbidden
 * `DEMO_SIGN_IN_ENABLED=true` + `APP_ENV=production` combination (staging + true parses; see the runtime gate).
 */
export function getDemoEnv(source: Record<string, string | undefined> = process.env): DemoEnv {
  const result = demoEnvSchema.safeParse(source)
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new Error(`Invalid environment configuration: ${issues}`)
  }
  return result.data
}

/**
 * Runtime gate for the public demo sign-in endpoint. Fail-closed: `true` only when the flag is exactly
 * `true` AND `APP_ENV` is `development` or `demo`; any invalid configuration, production and staging
 * (whatever the flag says — staging + true is a valid configuration but is still closed here) are `false`
 * (the route then answers exactly like an unknown route). Never throws.
 */
export function isDemoSignInEnabled(source: Record<string, string | undefined> = process.env): boolean {
  try {
    const env = getDemoEnv(source)
    return env.DEMO_SIGN_IN_ENABLED && (DEMO_SIGN_IN_APP_ENVS as readonly string[]).includes(env.APP_ENV)
  }
  catch {
    return false
  }
}

export function resetEnvCache(): void {
  cachedEnv = null
}
