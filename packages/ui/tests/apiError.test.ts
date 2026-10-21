import { describe, expect, it } from 'vitest'
import { ApiError, toApiError } from '../app/utils/apiError'

describe('toApiError', () => {
  it('reads the API standard error body: status, code, details and 422 issues', () => {
    const error = toApiError({ status: 422, data: { statusCode: 422, statusMessage: 'Request validation failed', data: { code: 'VALIDATION_FAILED', details: { issues: [{ path: ['lead', 'passportNo'], message: 'Required' }] } } } })
    expect(error).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' })
    expect(error.issues).toEqual([{ path: ['lead', 'passportNo'], message: 'Required' }])
    expect(toApiError({ status: 409, data: { statusCode: 409, statusMessage: 'x', data: { code: 'QUOTA_EXCEEDED', details: { maxPersons: 4 } } } }).detail('maxPersons')).toBe(4)
  })

  it('a fetch that got no answer is NETWORK (status 0); anything else UNKNOWN; an ApiError stays itself', () => {
    expect(toApiError({ message: 'fetch failed', response: undefined })).toMatchObject({ status: 0, code: 'NETWORK' })
    expect(toApiError(new Error('boom'))).toMatchObject({ status: 0, code: 'UNKNOWN' })
    const same = new ApiError(404, 'BOOKING_NOT_FOUND', 'x')
    expect(toApiError(same)).toBe(same)
    expect(toApiError({ status: 502, data: undefined })).toMatchObject({ status: 502, code: 'HTTP_502' })
  })
})
