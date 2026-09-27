import type { H3Event } from 'h3'
import { createError, defineEventHandler, getQuery, getRouterParams, isError, readBody } from 'h3'
import { z, ZodError, type ZodIssue } from 'zod'
import { DomainError, ValidationError } from '../errors/domainError'
import { translateDbError } from '../errors/dbErrors'

export interface ApiHandlerArgs<P, Q, B> {
  event: H3Event
  params: P
  query: Q
  body: B
}

export interface DefineApiHandlerOptions<P, Q, B, R> {
  // The `unknown` third type argument (Input) — rather than the schema's own
  // inferred input — is deliberate (PF-9): it lets a schema whose input type
  // differs from its output (`.default(...)`, `z.coerce...`) satisfy this
  // parameter, while `params`/`query`/`body` on the handler still carry the
  // schema's OUTPUT type (so a defaulted field is typed as its value, never
  // `T | undefined`). `z.ZodType<P>` alone would pin Input to P too, which a
  // coerced/defaulted schema's real input type never matches.
  params?: z.ZodType<P, z.ZodTypeDef, unknown>
  query?: z.ZodType<Q, z.ZodTypeDef, unknown>
  body?: z.ZodType<B, z.ZodTypeDef, unknown>
  /** Task 7 adds `'required'`, which hands the handler an additional `ctx: AuthContext`. */
  auth?: 'none'
  handler: (args: ApiHandlerArgs<P, Q, B>) => Promise<R>
}

/** Renders a `DomainError` as a real h3 error, so Nitro's production error handler keeps `data` (`code`/`details`) instead of discarding it as "unhandled". */
function domainErrorToHttp(error: DomainError): never {
  throw createError({ statusCode: error.httpStatus, statusMessage: error.message, data: { code: error.code, details: error.details } })
}

/**
 * Zod 3.25.x's own default `en` locale (`node_modules/zod/v3/locales/en.js`)
 * was checked issue-code by issue-code for anything that interpolates the
 * REJECTED VALUE (as opposed to the schema's own static expectations — a
 * type name, a literal/discriminator/enum constant, a min/max bound, a
 * `.includes`/`.startsWith`/`.endsWith` argument — none of which came from
 * the client's input):
 *   invalid_type              — `received` is a TYPE NAME ("string", "number", …), not the value: safe.
 *   invalid_literal            — echoes `expected` (the schema's own literal): safe.
 *   unrecognized_keys         — echoes extra KEY NAMES, never their values: safe.
 *   invalid_union              — static "Invalid input": safe.
 *   invalid_union_discriminator — echoes `options` (the schema's own discriminator values): safe.
 *   invalid_enum_value         — `Invalid enum value. Expected …, received '${issue.received}'` — ECHOES THE REJECTED VALUE. Same code for z.enum and z.nativeEnum. REWRITTEN below.
 *   invalid_arguments/invalid_return_type/invalid_date — static: safe.
 *   invalid_string             — echoes the schema's own `.includes`/`.startsWith`/`.endsWith`/validation-kind argument, never the input: safe.
 *   too_small/too_big          — echo the schema's own min/max bound: safe.
 *   custom                     — static "Invalid input" by default (a `.refine()` message we author ourselves is a separate concern — none of ours in shared/schemas/common.ts interpolate the input): safe.
 *   invalid_intersection_types/not_multiple_of/not_finite — static or echo the schema's own `multipleOf`: safe.
 * So only `invalid_enum_value` needs rewriting to keep "never echo the raw
 * input" true in general, not just for the codes exercised by today's schemas.
 */
function safeIssueMessage(issue: ZodIssue): string {
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    const allowed = issue.options.map(option => (typeof option === 'string' ? `'${option}'` : String(option))).join(' | ')
    return `Invalid value. Expected ${allowed}`
  }
  return issue.message
}

/** Zod issues carry `path` + `message` only — never the raw input (`received`, the value itself), which may hold a secret (e.g. a password field) or, for `z.enum`/`z.nativeEnum`, be echoed verbatim by Zod's own default message. */
function zodErrorToValidationError(error: ZodError): ValidationError {
  const issues = error.issues.map(issue => ({ path: issue.path, message: safeIssueMessage(issue) }))
  return new ValidationError('VALIDATION_FAILED', 'Request validation failed', { issues })
}

/**
 * Parses `raw` against `schema` and throws a 422 `ValidationError` (via
 * `domainErrorToHttp`) on failure — deliberately `safeParse`, never
 * `schema.parse`/h3's `getValidatedQuery`/`getValidatedRouterParams`/
 * `readValidatedBody`. Those h3 helpers catch the validator's own throw and
 * wrap it in `createError({ statusCode: 400, statusMessage: 'Validation
 * Error', data: <the raw ZodError> })`, which (a) reports 400 instead of our
 * 422 `VALIDATION_FAILED`, and (b) puts the *entire* ZodError — including
 * each issue's `received` value — on `data`, leaking whatever the client
 * sent (e.g. a rejected password) back in the response body.
 */
function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) domainErrorToHttp(zodErrorToValidationError(result.error))
  return result.data
}

function handleError(error: unknown): never {
  // A route (or a lower layer) may already have built a full H3Error — e.g.
  // login's deliberately generic "invalid organization, email, or password"
  // (never distinguishing which one failed). Pass it through unchanged
  // rather than reclassifying it as an internal error.
  if (isError(error)) throw error

  if (error instanceof DomainError) domainErrorToHttp(error)
  if (error instanceof ZodError) domainErrorToHttp(zodErrorToValidationError(error))

  const translated = translateDbError(error)
  if (translated) domainErrorToHttp(translated)

  // Unknown error: never leak internals (message, stack, driver detail) to
  // the client — the original is still logged here for operators.
  console.error(error)
  throw createError({ statusCode: 500, statusMessage: 'Internal server error', data: { code: 'INTERNAL_ERROR' } })
}

/**
 * Wraps a Nitro event handler with shared Zod validation and error
 * translation, so no individual route hand-rolls try/catch for a known
 * domain or database error (see server/errors/domainError.ts and
 * server/errors/dbErrors.ts). `auth` only ever accepts `'none'` here — Task 7
 * adds `'required'`.
 *
 * Router params/query/body are read RAW (`getRouterParams`/`getQuery`/
 * `readBody`) and validated ourselves via `parseOrThrow` — see its docstring
 * for why h3's own `getValidatedRouterParams`/`getValidatedQuery`/
 * `readValidatedBody` are deliberately not used here.
 */
export function defineApiHandler<P = void, Q = void, B = void, R = unknown>(opts: DefineApiHandlerOptions<P, Q, B, R>) {
  const paramsSchema = opts.params
  const querySchema = opts.query
  const bodySchema = opts.body

  return defineEventHandler(async (event: H3Event): Promise<R> => {
    try {
      const params = paramsSchema ? parseOrThrow(paramsSchema, getRouterParams(event)) : (undefined as P)
      const query = querySchema ? parseOrThrow(querySchema, getQuery(event)) : (undefined as Q)
      const body = bodySchema ? parseOrThrow(bodySchema, await readBody(event)) : (undefined as B)
      return await opts.handler({ event, params, query, body })
    }
    catch (error) {
      return handleError(error)
    }
  })
}

/**
 * PF-9 compile-time proof — never called; `pnpm typecheck` (which covers
 * this file) is what actually verifies it. `pageSchema`'s Zod INPUT (an
 * optional, coercible value — `.coerce` + `.default(1)`) differs from its
 * OUTPUT (`{ page: number }`). Had `query` above been typed `z.ZodType<Q>`
 * (Input defaulting to `Q`) instead of `z.ZodType<Q, z.ZodTypeDef,
 * unknown>`, `pageSchema` would not have been assignable to it, and
 * `query.page` below would be `number | undefined` rather than `number`.
 * (tests/types/**, checked by the separate `pnpm typecheck:types`, cannot
 * host this proof: that program has no Nitro ambient globals and no `dom`/
 * `node` lib for e.g. `console`.)
 */
export function __apiHandlerDefaultedQueryTypeProof() {
  const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1) })
  return defineApiHandler({
    query: pageSchema,
    handler: async ({ query }) => {
      const page: number = query.page
      return page
    },
  })
}
