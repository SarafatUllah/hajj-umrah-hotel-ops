import { describe, expect, it } from 'vitest'
import { auditCursorSchema, createHotelSchema, encodeAuditCursor, listHotelAuditQuerySchema, updateHotelSchema } from '../../../shared/schemas/hotel'

const VALID_HOTEL = {
  code: 'HTL-01',
  name: 'Al Safwah Royale',
  city: 'Makkah',
  timezone: 'Asia/Riyadh',
}

describe('createHotelSchema — code boundaries', () => {
  it('rejects a 1-character code (below the 2-character minimum)', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, code: 'A' }).success).toBe(false)
  })

  it('accepts a 2-character code (the minimum)', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, code: 'A1' }).success).toBe(true)
  })

  it('accepts a 20-character code (the maximum)', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, code: 'A'.repeat(20) }).success).toBe(true)
  })

  it('rejects a 21-character code (above the maximum)', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, code: 'A'.repeat(21) }).success).toBe(false)
  })

  it('rejects a lowercase code', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, code: 'htl-01' }).success).toBe(false)
  })

  it('rejects a code containing a space', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, code: 'HTL 01' }).success).toBe(false)
  })
})

describe('createHotelSchema — timezone', () => {
  it('rejects a non-IANA timezone', () => {
    const result = createHotelSchema.safeParse({ ...VALID_HOTEL, timezone: 'Mars/Olympus' })
    expect(result.success).toBe(false)
  })

  it('accepts a real IANA timezone', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, timezone: 'UTC' }).success).toBe(true)
  })
})

describe('createHotelSchema — check-in/out time', () => {
  it('rejects an out-of-range hour (25:00)', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, checkInTime: '25:00' }).success).toBe(false)
  })

  it('accepts a valid HH:MM', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, checkInTime: '14:30' }).success).toBe(true)
  })

  it('defaults checkInTime/checkOutTime to 15:00/12:00 when omitted', () => {
    const result = createHotelSchema.parse(VALID_HOTEL)
    expect(result.checkInTime).toBe('15:00')
    expect(result.checkOutTime).toBe('12:00')
  })
})

describe('createHotelSchema — currency', () => {
  it('rejects a lowercase currency code', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, currency: 'sar' }).success).toBe(false)
  })

  it('defaults currency to SAR and country to SA when omitted', () => {
    const result = createHotelSchema.parse(VALID_HOTEL)
    expect(result.currency).toBe('SAR')
    expect(result.country).toBe('SA')
  })
})

describe('createHotelSchema — name', () => {
  it('rejects a 121-character name (above safeText(120))', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, name: 'A'.repeat(121) }).success).toBe(false)
  })

  it('accepts a 120-character name (the maximum)', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, name: 'A'.repeat(120) }).success).toBe(true)
  })

  it('accepts an Arabic name', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, name: 'فندق الصفوة الملكي' }).success).toBe(true)
  })
})

describe('createHotelSchema — ownershipType', () => {
  it('defaults to OWNED', () => {
    expect(createHotelSchema.parse(VALID_HOTEL).ownershipType).toBe('OWNED')
  })

  it('rejects a value outside OWNERSHIP_TYPES', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, ownershipType: 'RENTED' }).success).toBe(false)
  })
})

describe('createHotelSchema — mass assignment', () => {
  it('rejects an unrecognized field (.strict())', () => {
    expect(createHotelSchema.safeParse({ ...VALID_HOTEL, status: 'INACTIVE' }).success).toBe(false)
  })
})

describe('updateHotelSchema — no mass assignment', () => {
  it('rejects status', () => {
    expect(updateHotelSchema.safeParse({ status: 'INACTIVE' }).success).toBe(false)
  })

  it('rejects code (immutable after creation)', () => {
    expect(updateHotelSchema.safeParse({ code: 'NEW-CODE' }).success).toBe(false)
  })

  it('rejects organizationId', () => {
    expect(updateHotelSchema.safeParse({ organizationId: '11111111-1111-1111-1111-111111111111' }).success).toBe(false)
  })

  it('rejects id', () => {
    expect(updateHotelSchema.safeParse({ id: '11111111-1111-1111-1111-111111111111' }).success).toBe(false)
  })

  it('accepts a partial patch of recognized fields', () => {
    expect(updateHotelSchema.safeParse({ name: 'New Name' }).success).toBe(true)
  })

  it('accepts an empty object (a caller who wants to patch nothing)', () => {
    expect(updateHotelSchema.safeParse({}).success).toBe(true)
  })
})

describe('audit cursor codec', () => {
  const VALID_UUID = '11111111-1111-1111-1111-111111111111'

  it('round-trips through encode/decode, preserving the full-precision timestamp string byte-for-byte', () => {
    const cursor = { createdAt: '2027-05-01 10:00:00.123456+00', id: VALID_UUID }
    const encoded = encodeAuditCursor(cursor)
    const parsed = auditCursorSchema.parse(encoded)
    expect(parsed).toEqual(cursor)
    expect(parsed.createdAt).toBe('2027-05-01 10:00:00.123456+00')
  })

  it('rejects a malformed cursor (not valid base64url-decodable to createdAt|id)', () => {
    expect(auditCursorSchema.safeParse('not-a-real-cursor').success).toBe(false)
  })

  it('rejects a cursor whose id half is not a uuid', () => {
    const bogus = encodeAuditCursor({ createdAt: '2027-05-01 10:00:00+00', id: 'not-a-uuid' })
    expect(auditCursorSchema.safeParse(bogus).success).toBe(false)
  })

  it('rejects a cursor whose createdAt half is not a valid timestamp (would otherwise reach the repository\'s raw ::timestamptz SQL cast)', () => {
    const invalidTimestampCursor = encodeAuditCursor({ createdAt: 'not-a-timestamp', id: VALID_UUID })
    expect(auditCursorSchema.safeParse(invalidTimestampCursor).success).toBe(false)
  })

  it('rejects a createdAt half with an invalid calendar date (e.g. Feb 30)', () => {
    const bogus = encodeAuditCursor({ createdAt: '2027-02-30 10:00:00+00', id: VALID_UUID })
    expect(auditCursorSchema.safeParse(bogus).success).toBe(false)
  })

  it('rejects a createdAt half with an out-of-range hour/minute/second', () => {
    expect(auditCursorSchema.safeParse(encodeAuditCursor({ createdAt: '2027-05-01 24:00:00+00', id: VALID_UUID })).success).toBe(false)
    expect(auditCursorSchema.safeParse(encodeAuditCursor({ createdAt: '2027-05-01 10:60:00+00', id: VALID_UUID })).success).toBe(false)
    expect(auditCursorSchema.safeParse(encodeAuditCursor({ createdAt: '2027-05-01 10:00:60+00', id: VALID_UUID })).success).toBe(false)
  })

  it('rejects a createdAt half with an out-of-range offset', () => {
    expect(auditCursorSchema.safeParse(encodeAuditCursor({ createdAt: '2027-05-01 10:00:00+15', id: VALID_UUID })).success).toBe(false)
  })

  it('accepts real repository-shaped timestamptz text values (no fractional seconds, and a +HH:MM offset)', () => {
    expect(auditCursorSchema.safeParse(encodeAuditCursor({ createdAt: '2027-05-01 10:00:00+00', id: VALID_UUID })).success).toBe(true)
    expect(auditCursorSchema.safeParse(encodeAuditCursor({ createdAt: '2027-05-01 10:00:00+05:30', id: VALID_UUID })).success).toBe(true)
  })
})

describe('listHotelAuditQuerySchema', () => {
  it('defaults limit to 50', () => {
    expect(listHotelAuditQuerySchema.parse({}).limit).toBe(50)
  })

  it('accepts limit=100 (the maximum)', () => {
    expect(listHotelAuditQuerySchema.safeParse({ limit: '100' }).success).toBe(true)
  })

  it('rejects limit=101 (above the maximum)', () => {
    expect(listHotelAuditQuerySchema.safeParse({ limit: '101' }).success).toBe(false)
  })

  it('rejects an entityType outside the fixed list', () => {
    expect(listHotelAuditQuerySchema.safeParse({ entityType: 'invoice' }).success).toBe(false)
  })

  it('rejects an action outside AUDIT_ACTIONS', () => {
    expect(listHotelAuditQuerySchema.safeParse({ action: 'NOT_A_REAL_ACTION' }).success).toBe(false)
  })

  it('rejects an unrecognized query key (.strict())', () => {
    expect(listHotelAuditQuerySchema.safeParse({ bogus: 'x' }).success).toBe(false)
  })
})
