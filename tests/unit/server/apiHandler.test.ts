import type { H3Event } from 'h3'
import { createError, createEvent, isError, sendError } from 'h3'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NotFoundError } from '../../../server/errors/domainError'
import { defineApiHandler } from '../../../server/utils/apiHandler'

/**
 * A minimal, real h3 `H3Event` (via h3's own `createEvent`) backed by fake
 * Node `req`/`res` objects — just enough for `getRouterParams`/`getQuery`/
 * `readBody`/`sendError` (the real h3 functions this suite exercises) to
 * work, without a live HTTP request/response or a Nitro server.
 */
function makeEvent(opts: {
  method?: string
  url?: string
  headers?: Record<string, string>
  rawBody?: string
  params?: Record<string, string>
  onEnd?: (chunk: string) => void
} = {}): H3Event {
  const req = {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/',
    headers: opts.headers ?? {},
  }
  const res = {
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    writableEnded: false,
    setHeader: () => {},
    end: (chunk: string) => opts.onEnd?.(chunk),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a minimal Node req/res stand-in, not a real IncomingMessage/ServerResponse.
  const event = createEvent(req as any, res as any)
  if (opts.rawBody !== undefined) {
    // h3's readRawBody checks `event._requestBody` before falling back to a
    // real stream read — the simplest way to hand it a body without faking
    // one.
    (event as unknown as { _requestBody: string })._requestBody = opts.rawBody
  }
  if (opts.params) event.context.params = opts.params
  return event
}

// Scenarios with no params/query/body schema never touch getRouterParams/
// getQuery/readBody, so a bare event is enough for them.
const dummyEvent = makeEvent()

describe('defineApiHandler error translation', () => {
  it('maps a DomainError subclass to its fixed HTTP status and stable code', async () => {
    const handler = defineApiHandler({
      auth: 'none',
      handler: async () => {
        throw new NotFoundError('HOTEL_NOT_FOUND')
      },
    })

    let caught: unknown
    try {
      await handler(dummyEvent)
    }
    catch (error) {
      caught = error
    }

    // Must be a REAL h3 error (Nitro's production error handler drops
    // `data` for anything that doesn't satisfy h3's own `isError`).
    expect(isError(caught)).toBe(true)
    expect(caught).toMatchObject({
      statusCode: 404,
      statusMessage: 'HOTEL_NOT_FOUND',
      data: { code: 'HOTEL_NOT_FOUND' },
    })
  })

  it('maps a ZodError (thrown directly by the handler) to 422 with issues carrying path + message only', async () => {
    const schema = z.object({ email: z.string().email() })
    const handler = defineApiHandler({
      auth: 'none',
      handler: async () => {
        schema.parse({ email: 'not-an-email' })
        return null
      },
    })

    let caught: { statusCode?: number, data?: { code?: string, details?: { issues?: unknown[] } } } | undefined
    try {
      await handler(dummyEvent)
    }
    catch (error) {
      caught = error as typeof caught
    }

    expect(isError(caught)).toBe(true)
    expect(caught?.statusCode).toBe(422)
    expect(caught?.data?.code).toBe('VALIDATION_FAILED')
    expect(caught?.data?.details?.issues).toEqual([{ path: ['email'], message: expect.any(String) }])
  })

  it('maps a raw Error to 500 without leaking its message', async () => {
    const handler = defineApiHandler({
      auth: 'none',
      handler: async () => {
        throw new Error('super secret internal detail')
      },
    })

    let caught: unknown
    try {
      await handler(dummyEvent)
    }
    catch (error) {
      caught = error
    }

    expect(isError(caught)).toBe(true)
    expect((caught as { statusCode?: number }).statusCode).toBe(500)
    expect(JSON.stringify(caught)).not.toContain('super secret internal detail')
  })

  it('passes an already-built h3 error through unchanged (e.g. a route-level generic auth failure)', async () => {
    const handler = defineApiHandler({
      auth: 'none',
      handler: async () => {
        throw createError({ statusCode: 401, statusMessage: 'Invalid organization, email, or password' })
      },
    })

    await expect(handler(dummyEvent)).rejects.toMatchObject({ statusCode: 401, statusMessage: 'Invalid organization, email, or password' })
  })

  it('returns the handler result unchanged on success', async () => {
    const handler = defineApiHandler({
      auth: 'none',
      handler: async () => ({ ok: true }),
    })

    await expect(handler(dummyEvent)).resolves.toEqual({ ok: true })
  })

  it('a thrown DomainError still carries data.code/details after a real h3 sendError round trip (Nitro would otherwise drop them for a non-H3 error)', async () => {
    const handler = defineApiHandler({
      auth: 'none',
      handler: async () => {
        throw new NotFoundError('HOTEL_NOT_FOUND', 'No such hotel', { hotelId: 'h1' })
      },
    })

    let caught: unknown
    try {
      await handler(dummyEvent)
    }
    catch (error) {
      caught = error
    }
    expect(isError(caught)).toBe(true)

    let sentBody = ''
    const sendEvent = makeEvent({ onEnd: chunk => { sentBody = chunk } })
    sendError(sendEvent, caught as Error)

    expect(sendEvent.node.res.statusCode).toBe(404)
    const parsed = JSON.parse(sentBody)
    expect(parsed.statusMessage).toBe('No such hotel')
    expect(parsed.data).toEqual({ code: 'HOTEL_NOT_FOUND', details: { hotelId: 'h1' } })
  })
})

describe('defineApiHandler real h3 request-parsing path (params/query/body)', () => {
  it('validates the body via getRouterParams/getQuery/readBody + schema.safeParse — never leaks a rejected value (e.g. a password) the way h3\'s own getValidatedQuery/getValidatedRouterParams/readValidatedBody would', async () => {
    const bodySchema = z.object({
      email: z.string().email(),
      password: z.literal('x'),
    })
    const handler = defineApiHandler({
      body: bodySchema,
      auth: 'none',
      handler: async ({ body }) => body,
    })

    const event = makeEvent({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify({ email: 'bad', password: 'hunter2' }),
    })

    let caught: { statusCode?: number, statusMessage?: string, data?: { code?: string, details?: { issues?: { path: unknown[], message: string }[] } } } | undefined
    try {
      await handler(event)
    }
    catch (error) {
      caught = error as typeof caught
    }

    expect(isError(caught)).toBe(true)
    // h3's own getValidatedRouterParams/getValidatedQuery/readValidatedBody
    // would report statusCode 400 / statusMessage "Validation Error" here —
    // this wrapper must report the domain shape instead.
    expect(caught?.statusCode).toBe(422)
    expect(caught?.statusMessage).toBe('Request validation failed')
    expect(caught?.data?.code).toBe('VALIDATION_FAILED')
    expect(caught?.data?.details?.issues).toEqual([
      { path: ['email'], message: expect.any(String) },
      { path: ['password'], message: expect.any(String) },
    ])

    // Never echoes the rejected raw values (the invalid email, and
    // critically the password) anywhere in the error.
    const serialized = JSON.stringify(caught)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('"bad"')
    expect(serialized).not.toContain('received')
  })

  it('z.enum: never echoes the rejected value, even though Zod\'s own default message for invalid_enum_value does ("...received \'x\'")', async () => {
    const bodySchema = z.object({ role: z.enum(['admin', 'staff']) })
    const handler = defineApiHandler({
      body: bodySchema,
      auth: 'none',
      handler: async ({ body }) => body,
    })

    const event = makeEvent({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify({ role: 'hunter2' }),
    })

    let caught: { statusCode?: number, data?: { code?: string, details?: { issues?: { path: unknown[], message: string }[] } } } | undefined
    try {
      await handler(event)
    }
    catch (error) {
      caught = error as typeof caught
    }

    expect(isError(caught)).toBe(true)
    expect(caught?.statusCode).toBe(422)
    expect(caught?.data?.code).toBe('VALIDATION_FAILED')
    expect(caught?.data?.details?.issues).toEqual([{ path: ['role'], message: expect.any(String) }])
    // The message must still be useful — it names the allowed options.
    expect(caught?.data?.details?.issues?.[0]?.message).toBe('Invalid value. Expected \'admin\' | \'staff\'')

    const serialized = JSON.stringify(caught)
    expect(serialized).not.toContain('hunter2')
    expect(serialized.toLowerCase()).not.toContain('received')
  })

  it('z.nativeEnum: same invalid_enum_value code as z.enum, same leak, same fix', async () => {
    enum Role { Admin = 'admin', Staff = 'staff' }
    const bodySchema = z.object({ role: z.nativeEnum(Role) })
    const handler = defineApiHandler({
      body: bodySchema,
      auth: 'none',
      handler: async ({ body }) => body,
    })

    const event = makeEvent({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify({ role: 'hunter2' }),
    })

    let caught: { statusCode?: number, data?: { code?: string, details?: { issues?: { path: unknown[], message: string }[] } } } | undefined
    try {
      await handler(event)
    }
    catch (error) {
      caught = error as typeof caught
    }

    expect(isError(caught)).toBe(true)
    expect(caught?.statusCode).toBe(422)
    expect(caught?.data?.code).toBe('VALIDATION_FAILED')
    expect(caught?.data?.details?.issues).toEqual([{ path: ['role'], message: expect.any(String) }])
    expect(caught?.data?.details?.issues?.[0]?.message).toBe('Invalid value. Expected \'admin\' | \'staff\'')

    const serialized = JSON.stringify(caught)
    expect(serialized).not.toContain('hunter2')
    expect(serialized.toLowerCase()).not.toContain('received')
  })

  it('validates router params and query via the same real path', async () => {
    const handler = defineApiHandler({
      params: z.object({ hotelId: z.string().uuid() }),
      query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
      auth: 'none',
      handler: async ({ params, query }) => ({ params, query }),
    })

    const event = makeEvent({ url: '/api/hotels/not-a-uuid?page=3', params: { hotelId: 'not-a-uuid' } })

    let caught: { statusCode?: number, data?: { code?: string } } | undefined
    try {
      await handler(event)
    }
    catch (error) {
      caught = error as typeof caught
    }

    expect(isError(caught)).toBe(true)
    expect(caught?.statusCode).toBe(422)
    expect(caught?.data?.code).toBe('VALIDATION_FAILED')
  })

  it('accepts valid params/query and hands the handler the coerced/defaulted output', async () => {
    const hotelId = '123e4567-e89b-12d3-a456-426614174000'
    const handler = defineApiHandler({
      params: z.object({ hotelId: z.string().uuid() }),
      query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
      auth: 'none',
      handler: async ({ params, query }) => ({ params, query }),
    })

    const event = makeEvent({ url: `/api/hotels/${hotelId}?page=3`, params: { hotelId } })

    await expect(handler(event)).resolves.toEqual({ params: { hotelId }, query: { page: 3 } })
  })
})
