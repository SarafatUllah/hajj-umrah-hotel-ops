import { z } from 'zod'

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'demo', 'staging', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  NUXT_SESSION_PASSWORD: z.string().min(32, 'NUXT_SESSION_PASSWORD must be at least 32 characters'),
})

export type Env = z.infer<typeof envSchema>

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

export function resetEnvCache(): void {
  cachedEnv = null
}
