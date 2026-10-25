import { z } from 'zod'
import { DEFAULT_DEMO_ANCHOR_DATE, DEMO_ANCHOR_MAX, DEMO_ANCHOR_MIN, isValidDemoAnchorDate } from '../demo/catalog'
import { parseKeyRing, parseLookupKey } from '../security/piiCrypto'

/** Strict boolean flag: only the literal strings `true` / `false` (anything else is a configuration error, never a silent `false`). */
const strictFlag = (name: string) => z
  .enum(['true', 'false'], { errorMap: () => ({ message: `${name} must be "true" or "false"` }) })
  .default('false')
  .transform(value => value === 'true')

/** Runs a throwing parser as a Zod refinement, reporting its message (never the value itself — these are secrets). */
const parsedBy = (parse: (value: string) => unknown) => (value: string, ctx: z.RefinementCtx) => {
  try {
    parse(value)
  }
  catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'invalid value' })
  }
}

const isExactOrigin = (value: string): boolean => {
  try {
    return new URL(value).origin === value
  }
  catch {
    return false
  }
}

/** `ALLOWED_ORIGINS`: comma-separated exact origins (`https://ops.example.com`), or unset = same host only. */
const originList = z.string().optional().transform((value, ctx) => {
  const origins = (value ?? '').split(',').map(part => part.trim()).filter(Boolean)
  for (const origin of origins) {
    if (!isExactOrigin(origin)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ALLOWED_ORIGINS entries must be exact origins like https://ops.example.com (got "${origin}")` })
  }
  return origins
})

const envBase = z.object({
  APP_ENV: z.enum(['development', 'demo', 'staging', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  NUXT_SESSION_PASSWORD: z.string().min(32, 'NUXT_SESSION_PASSWORD must be at least 32 characters'),
  // Read by nuxt.config.ts (unset = true); validated here only so production can refuse `false`.
  NUXT_SESSION_COOKIE_SECURE: z.string().optional(),
  // Task 19: where document bytes live: `local` (a directory, resolved against the process working directory) or
  // `s3` (one private bucket of an S3-compatible store — AWS S3, Cloudflare R2, Supabase Storage, MinIO; brought forward
  // from Phase 9 for hosts without a lasting disk, D-P2-67). Any other value is a configuration error, never a silent
  // fallback.
  STORAGE_DRIVER: z.enum(['local', 's3'], { errorMap: () => ({ message: 'STORAGE_DRIVER must be "local" or "s3"' }) }).default('local'),
  STORAGE_LOCAL_DIR: z.string().trim().min(1, 'STORAGE_LOCAL_DIR must not be empty').default('.data/uploads'),
  S3_ENDPOINT: z.string().trim().url('S3_ENDPOINT must be a URL').optional(),
  S3_REGION: z.string().trim().min(1).optional(),
  S3_BUCKET: z.string().trim().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: strictFlag('S3_FORCE_PATH_STYLE'),
  // Task 20 (demo): `ALLOW_DEMO_SEED` lets the demo seed/reset run under APP_ENV=production (never silent);
  // `DEMO_ANCHOR_DATE` is the date every time-relative demo row hangs off; `DEMO_SIGN_IN_ENABLED` switches
  // the public demo sign-in metadata endpoint on (only ever honoured under APP_ENV development/demo).
  ALLOW_DEMO_SEED: strictFlag('ALLOW_DEMO_SEED'),
  DEMO_ANCHOR_DATE: z.string().trim().refine(isValidDemoAnchorDate, { message: `DEMO_ANCHOR_DATE must be a real YYYY-MM-DD date between ${DEMO_ANCHOR_MIN} and ${DEMO_ANCHOR_MAX}` }).default(DEFAULT_DEMO_ANCHOR_DATE),
  DEMO_SIGN_IN_ENABLED: strictFlag('DEMO_SIGN_IN_ENABLED'),
  // Phase 2a security (design v7 §21). PII encryption key ring ("id:base64key[,id:base64key]", first encrypts,
  // all decrypt) and the separate blind-index key; both required, never defaulted.
  PII_ENCRYPTION_KEYS: z.string({ required_error: 'PII_ENCRYPTION_KEYS is required' }).min(1, 'PII_ENCRYPTION_KEYS is required').superRefine(parsedBy(parseKeyRing)),
  PII_LOOKUP_KEY: z.string({ required_error: 'PII_LOOKUP_KEY is required' }).min(1, 'PII_LOOKUP_KEY is required').superRefine(parsedBy(parseLookupKey)),
  // Trust X-Forwarded-For / X-Forwarded-Host (only behind a reverse proxy that sets them).
  TRUST_PROXY: strictFlag('TRUST_PROXY'),
  ALLOWED_ORIGINS: originList,
  // Staff 2FA: `required-roles` makes users holding a role with requires_two_factor enrol TOTP before using the API.
  STAFF_2FA_ENFORCEMENT: z.enum(['off', 'required-roles'], { errorMap: () => ({ message: 'STAFF_2FA_ENFORCEMENT must be off or required-roles' }) }).default('off'),
  // Phase 2a: customer sign-in codes by SMS. `disabled` (default) = customer sign-in answers 503 until a gateway is
  // configured; `log` = development only (writes the code to the server log; refused in production); `webhook` =
  // POST { to, text } to SMS_WEBHOOK_URL (https), with SMS_WEBHOOK_TOKEN as a bearer token when set.
  SMS_DRIVER: z.enum(['disabled', 'log', 'webhook'], { errorMap: () => ({ message: 'SMS_DRIVER must be disabled, log or webhook' }) }).default('disabled'),
  SMS_WEBHOOK_URL: z.string().url('SMS_WEBHOOK_URL must be a URL').optional(),
  SMS_WEBHOOK_TOKEN: z.string().min(1).optional(),
  // Only these country calling codes may receive sign-in codes (SMS-pumping / toll-fraud guard), e.g. "966,880,92,62".
  SMS_ALLOWED_CALLING_CODES: z.string().default('966').transform((value, ctx) => {
    const codes = value.split(',').map(part => part.trim()).filter(Boolean)
    if (codes.length === 0 || codes.some(code => !/^[1-9]\d{0,3}$/.test(code))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SMS_ALLOWED_CALLING_CODES must be comma-separated calling codes like 966,880' })
    return codes
  }),
  // SMS budget per organization (all phones): a flood cannot run up the bill or lock everyone out for long.
  SMS_HOURLY_LIMIT: z.coerce.number().int().min(1).max(100_000).default(300),
  SMS_DAILY_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(2000),
  // Bot check on the code request: `off` (default) or `turnstile` (Cloudflare Turnstile, secret in CAPTCHA_SECRET).
  CAPTCHA_DRIVER: z.enum(['off', 'turnstile'], { errorMap: () => ({ message: 'CAPTCHA_DRIVER must be off or turnstile' }) }).default('off'),
  CAPTCHA_SECRET: z.string().min(1).optional(),
  // Phase 2 (jobs): which background queues this API process works. `light` (default) = everything
  // except CPU-heavy jobs (passport OCR), which run in the separate worker process; `all` = a single-process
  // deployment; `send` = enqueue only; `off` = no job runtime (enqueueing then fails loudly).
  JOBS_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
  JOBS_MODE: z.enum(['off', 'send', 'light', 'all'], { errorMap: () => ({ message: 'JOBS_MODE must be off, send, light or all' }) }).default('light'),
  // The worker process (`pnpm --filter @hajj/api worker`): `heavy` (default) = only the CPU-heavy queues, next to API
  // processes that work the light ones; `all` = every queue, for hosts where the API only enqueues (serverless
  // functions with JOBS_MODE=send, D-P2-67).
  WORKER_JOBS: z.enum(['heavy', 'all'], { errorMap: () => ({ message: 'WORKER_JOBS must be heavy or all' }) }).default('heavy'),
  // How often each queue a process works is polled for new jobs (seconds). Longer = less database and CPU time while
  // idle (a quota-metered host), at the cost of a job starting up to that much later; schedules are not affected.
  JOBS_POLL_SECONDS: z.coerce.number({ invalid_type_error: 'JOBS_POLL_SECONDS must be a number of seconds' }).int().min(1, 'JOBS_POLL_SECONDS must be 1-300').max(300, 'JOBS_POLL_SECONDS must be 1-300').default(2),
  // Phase 2d: reading passport images (v7 §13), in the worker. `PASSPORT_OCR=tesseract` reads the MRZ on our own
  // server (the worker image must have the `tesseract.js` package and its English data installed); `none` (default)
  // sends every scan straight to manual review. `PASSPORT_AI=anthropic` is the external fallback (Claude vision) when
  // the MRZ cannot be read — off by default (§23 Q24: only after the contract and data-region review); it needs
  // ANTHROPIC_API_KEY. PASSPORT_AI_MODEL picks the model.
  PASSPORT_OCR: z.enum(['none', 'tesseract'], { errorMap: () => ({ message: 'PASSPORT_OCR must be none or tesseract' }) }).default('none'),
  PASSPORT_AI: z.enum(['none', 'anthropic'], { errorMap: () => ({ message: 'PASSPORT_AI must be none or anthropic' }) }).default('none'),
  PASSPORT_AI_MODEL: z.string().min(1).default('claude-opus-5-5'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
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

/** The start of `.env.example`'s session password: copied unchanged it is a publicly known key that seals every session. */
const EXAMPLE_SESSION_PASSWORD_PREFIX = 'change-this'

/**
 * Production may not run without staff two-factor enforcement (design v7 §21: a launch prerequisite) or with a
 * session cookie that is not Secure; no shared environment (anything but development) may write sign-in codes to the
 * log or seal sessions with the example password.
 */
function refineProductionSecurity(env: { APP_ENV: string, STAFF_2FA_ENFORCEMENT: string, SMS_DRIVER: string, CAPTCHA_DRIVER: string, NUXT_SESSION_PASSWORD: string, NUXT_SESSION_COOKIE_SECURE?: string }, ctx: z.RefinementCtx): void {
  if (env.APP_ENV === 'production' && env.STAFF_2FA_ENFORCEMENT !== 'required-roles') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['STAFF_2FA_ENFORCEMENT'], message: 'STAFF_2FA_ENFORCEMENT must be required-roles with APP_ENV=production' })
  }
  // Nuxt reads the override leniently (`False`, `0` … turn Secure off too): production accepts only unset, true or 1.
  const cookieSecure = env.NUXT_SESSION_COOKIE_SECURE?.trim().toLowerCase()
  if (env.APP_ENV === 'production' && cookieSecure !== undefined && cookieSecure !== 'true' && cookieSecure !== '1') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NUXT_SESSION_COOKIE_SECURE'], message: 'NUXT_SESSION_COOKIE_SECURE=false is not allowed with APP_ENV=production (unset it or set true)' })
  }
  if (env.APP_ENV !== 'development' && env.NUXT_SESSION_PASSWORD.startsWith(EXAMPLE_SESSION_PASSWORD_PREFIX)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NUXT_SESSION_PASSWORD'], message: 'NUXT_SESSION_PASSWORD is still the example value: generate one (openssl rand -base64 48)' })
  }
  if (env.APP_ENV !== 'development' && env.SMS_DRIVER === 'log') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMS_DRIVER'], message: 'SMS_DRIVER=log is allowed only with APP_ENV=development' })
  }
  // Texting sign-in codes outside development needs the bot check (SMS pumping; a stranger's phone flooded with codes).
  if (env.APP_ENV !== 'development' && env.SMS_DRIVER !== 'disabled' && env.SMS_DRIVER !== 'log' && env.CAPTCHA_DRIVER !== 'turnstile') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CAPTCHA_DRIVER'], message: 'CAPTCHA_DRIVER must be turnstile when sign-in codes are texted outside APP_ENV=development' })
  }
}

/** The webhook driver needs an https URL (a sign-in code must never travel in clear text); Turnstile needs its secret. */
function refineSmsWebhook(env: { SMS_DRIVER: string, SMS_WEBHOOK_URL?: string, CAPTCHA_DRIVER: string, CAPTCHA_SECRET?: string }, ctx: z.RefinementCtx): void {
  if (env.SMS_DRIVER === 'webhook' && !env.SMS_WEBHOOK_URL?.startsWith('https://')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMS_WEBHOOK_URL'], message: 'SMS_WEBHOOK_URL (https) is required with SMS_DRIVER=webhook' })
  }
  if (env.CAPTCHA_DRIVER === 'turnstile' && !env.CAPTCHA_SECRET) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CAPTCHA_SECRET'], message: 'CAPTCHA_SECRET is required with CAPTCHA_DRIVER=turnstile' })
  }
}

/** The blind-index key must never be one of the encryption keys (one leaked key would then break both). */
function isLookupKeyReused(env: { PII_ENCRYPTION_KEYS: string, PII_LOOKUP_KEY: string }): boolean {
  try {
    const lookupKey = parseLookupKey(env.PII_LOOKUP_KEY)
    return parseKeyRing(env.PII_ENCRYPTION_KEYS).some(({ key }) => key.equals(lookupKey))
  }
  catch {
    return false // a malformed key is already reported by its own field
  }
}

function refineDistinctPiiKeys(env: { PII_ENCRYPTION_KEYS: string, PII_LOOKUP_KEY: string }, ctx: z.RefinementCtx): void {
  if (isLookupKeyReused(env)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['PII_LOOKUP_KEY'], message: 'PII_LOOKUP_KEY must differ from every PII_ENCRYPTION_KEYS key' })
}

const S3_REQUIRED = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const

/** The s3 driver needs every one of its settings, and its endpoint over https outside development (local MinIO). */
function refineS3Storage(env: { APP_ENV: string, STORAGE_DRIVER: string } & Partial<Record<typeof S3_REQUIRED[number], string>>, ctx: z.RefinementCtx): void {
  if (env.STORAGE_DRIVER !== 's3') return
  for (const name of S3_REQUIRED) {
    if (!env[name]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} is required with STORAGE_DRIVER=s3` })
  }
  if (env.APP_ENV !== 'development' && env.S3_ENDPOINT && !env.S3_ENDPOINT.startsWith('https://')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['S3_ENDPOINT'], message: 'S3_ENDPOINT must be https outside APP_ENV=development' })
  }
}

function refinePassportAi(env: { PASSPORT_AI: string, ANTHROPIC_API_KEY?: string }, ctx: z.RefinementCtx): void {
  if (env.PASSPORT_AI === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ANTHROPIC_API_KEY'], message: 'ANTHROPIC_API_KEY is required with PASSPORT_AI=anthropic' })
  }
}

const envSchema = envBase.superRefine(refineDemoSignIn).superRefine(refineProductionSecurity).superRefine(refineDistinctPiiKeys).superRefine(refineSmsWebhook).superRefine(refinePassportAi).superRefine(refineS3Storage)

export type Env = z.infer<typeof envSchema>

/** Just the storage settings, so the storage factory (and its startup check) does not depend on the database settings being valid. */
const storageEnvSchema = envBase.pick({
  APP_ENV: true,
  STORAGE_DRIVER: true,
  STORAGE_LOCAL_DIR: true,
  S3_ENDPOINT: true,
  S3_REGION: true,
  S3_BUCKET: true,
  S3_ACCESS_KEY_ID: true,
  S3_SECRET_ACCESS_KEY: true,
  S3_FORCE_PATH_STYLE: true,
}).superRefine(refineS3Storage)
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
