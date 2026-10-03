import { z } from 'zod'

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'demo', 'staging', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  NUXT_SESSION_PASSWORD: z.string().min(32, 'NUXT_SESSION_PASSWORD must be at least 32 characters'),
  // Task 19: where document bytes live. Only `local` exists in Phase 1 (S3-compatible is Phase 9); any
  // other value is a configuration error, never a silent fallback. The directory is resolved against
  // the process working directory.
  STORAGE_DRIVER: z.enum(['local'], { errorMap: () => ({ message: 'STORAGE_DRIVER must be "local"' }) }).default('local'),
  STORAGE_LOCAL_DIR: z.string().trim().min(1, 'STORAGE_LOCAL_DIR must not be empty').default('.data/uploads'),
})

export type Env = z.infer<typeof envSchema>

/** Just the storage settings, so the storage factory (and its startup check) does not depend on the database settings being valid. */
const storageEnvSchema = envSchema.pick({ STORAGE_DRIVER: true, STORAGE_LOCAL_DIR: true })
export type StorageEnv = z.infer<typeof storageEnvSchema>

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

export function resetEnvCache(): void {
  cachedEnv = null
}
