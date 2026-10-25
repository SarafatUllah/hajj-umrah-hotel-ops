import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { agencyUser, auditLog, hotel as hotelTable, priceQuote } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { quoteExpiryJob } from '../../../server/jobs/bookingJobs'
import { resolveAgencyContext, type AgencyContext } from '../../../server/security/agencyContext'
import { consumeRateLimit, RATE_LIMITS } from '../../../server/security/rateLimit'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { createBookingRule, createQuoteForAgency, declineQuote, getAgencyQuote, getQuote, listAgencyQuotes, listQuotes, offerQuote, requestQuote, updateBookingSettings } from '../../../server/services/booking'
import { makeAgency } from '../../support/bookingFixtures'
import { makeHotel, makeOrg, makeRoomType, makeUser } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()
const NOW = new Date('2027-05-01T10:00:00Z')

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

function staff(scope: OrganizationScope, userId: string, permissions: Permission[], hotelIds: string[] = []): AuthContext {
  return { identity: { userId, organizationId: scope.organizationId, email: 's@example.test', fullName: 'Seller' }, authz: { permissions: new Set(permissions), allHotels: hotelIds.length === 0, hotelIds: new Set(hotelIds) }, scope, db: db as Database, now: () => NOW }
}

async function agencyCtx(scope: OrganizationScope, agencyId: string): Promise<AgencyContext> {
  const [user] = await db.insert(agencyUser).values({ organizationId: scope.organizationId, agencyId, email: `u-${agencyId}@example.test`, passwordHash: 'h', fullName: 'Agent' }).returning()
  return (await resolveAgencyContext(db as Database, { agencyUserId: user!.id, organizationId: scope.organizationId, agencyId }, () => NOW))!
}

async function setup() {
  const { scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope, { code: 'MKK-GRAND' })
  const roomType = await makeRoomType(db, scope)
  const seller = await makeUser(db, scope)
  const agencyRow = await makeAgency(db, scope, { name: 'Al-Noor Travels' })
  const manager = staff(scope, seller.id, ['quote.manage', 'booking.view', 'booking.settings', 'rate.manage', 'rate.view'])
  return { scope, hotel, roomType, agencyRow, manager, agency: await agencyCtx(scope, agencyRow.id) }
}

const request = (hotelId: string) => ({ hotelId, bookingType: 'GROUP' as const, checkIn: '2027-06-01', checkOut: '2027-06-10', maleCount: 18, femaleCount: 12, totalCount: 30 })

describe('WhatsApp quotes (v7 §8)', () => {
  it('an agency asks: REQUESTED with Q-<year>-0001, -0002…; the WhatsApp link appears once a number is configured; audited', async () => {
    const env = await setup()
    const first = await requestQuote(env.agency, request(env.hotel.id))
    expect(first).toEqual({ quote: expect.objectContaining({ refNo: 'Q-2027-0001', status: 'REQUESTED', agencyId: env.agencyRow.id, amountHalalas: null }), whatsappLink: null })

    await updateBookingSettings(env.manager, { whatsappNumber: '966512345678' })
    const second = await requestQuote(env.agency, request(env.hotel.id))
    expect(second.quote.refNo).toBe('Q-2027-0002')
    expect(second.whatsappLink).toMatch(/^https:\/\/wa\.me\/966512345678\?text=/)
    expect(decodeURIComponent(second.whatsappLink!.split('text=')[1]!)).toContain('Q-2027-0002')

    const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, first.quote.id), eq(auditLog.action, 'QUOTE_REQUESTED')))
    expect(audit).toEqual([expect.objectContaining({ actorUserId: null })])
  })

  it('the reference year is the hotel\'s: just after midnight on 1 January in Makkah is next year\'s', async () => {
    const env = await setup()
    const newYearsEve = (await resolveAgencyContext(db as Database, { agencyUserId: env.agency.identity.agencyUserId, organizationId: env.scope.organizationId, agencyId: env.agencyRow.id }, () => new Date('2027-12-31T21:30:00Z')))!
    expect((await requestQuote(newYearsEve, request(env.hotel.id))).quote.refNo).toBe('Q-2028-0001')
    expect((await requestQuote(env.agency, request(env.hotel.id))).quote.refNo).toBe('Q-2027-0001')
  })

  it('quote requests are rate limited per agency (429 with Retry-After)', async () => {
    const env = await setup()
    for (let i = 0; i < RATE_LIMITS.quoteRequestPerAgency.limit; i++) await consumeRateLimit(db as Database, RATE_LIMITS.quoteRequestPerAgency, env.agencyRow.id, NOW)
    await expect(requestQuote(env.agency, request(env.hotel.id))).rejects.toMatchObject({ httpStatus: 429, retryAfterSeconds: expect.any(Number) })
    expect(await db.select().from(priceQuote)).toEqual([])
  })

  it('concurrent requests never share a reference number', async () => {
    const env = await setup()
    const results = await Promise.all(Array.from({ length: 8 }, () => requestQuote(env.agency, request(env.hotel.id))))
    expect(new Set(results.map(r => r.quote.refNo)).size).toBe(8)
  })

  it('an agency sees only its own quotes; an inactive hotel or a pending agency cannot get one (422)', async () => {
    const env = await setup()
    const mine = await requestQuote(env.agency, request(env.hotel.id))
    const otherAgency = await makeAgency(db, env.scope)
    const other = await agencyCtx(env.scope, otherAgency.id)
    expect((await listAgencyQuotes(other, { page: 1, pageSize: 20 })).items).toEqual([])
    await expect(getAgencyQuote(other, mine.quote.id)).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND', httpStatus: 404 })
    expect((await getAgencyQuote(env.agency, mine.quote.id)).refNo).toBe(mine.quote.refNo)

    const pending = await makeAgency(db, env.scope, { status: 'PENDING', approvedAt: null })
    await expect(createQuoteForAgency(env.manager, { ...request(env.hotel.id), agencyId: pending.id })).rejects.toMatchObject({ code: 'AGENCY_NOT_APPROVED', httpStatus: 422 })
    await db.update(hotelTable).set({ status: 'INACTIVE' }).where(eq(hotelTable.id, env.hotel.id))
    await expect(requestQuote(env.agency, request(env.hotel.id))).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })
  })

  it('staff offer the price (default validity 48 h), with a warning above the highest public rate; then it expires', async () => {
    const env = await setup()
    await createBookingRule(env.manager, env.hotel.id, 'rates', { roomTypeId: env.roomType.id, priceType: 'PUBLIC', unit: 'PER_PERSON_NIGHT', startDate: '2027-06-01', endDate: '2027-06-30', amountHalalas: 38000, vatIncluded: true })
    const { quote } = await requestQuote(env.agency, request(env.hotel.id))

    const offered = await offerQuote(env.manager, quote.id, { amountHalalas: 35000, unit: 'PER_PERSON_NIGHT', vatIncluded: true })
    expect(offered).toEqual({ quote: expect.objectContaining({ status: 'OFFERED', amountHalalas: 35000, validUntil: '2027-05-03T10:00:00.000Z', agencyName: 'Al-Noor Travels' }), aboveHighestPublicRate: false })
    expect((await offerQuote(env.manager, quote.id, { amountHalalas: 40000, unit: 'PER_PERSON_NIGHT', vatIncluded: true, validHours: 1 })).aboveHighestPublicRate).toBe(true)
    expect((await getAgencyQuote(env.agency, quote.id)).status).toBe('OFFERED')

    const later = (await resolveAgencyContext(db as Database, { agencyUserId: env.agency.identity.agencyUserId, organizationId: env.scope.organizationId, agencyId: env.agencyRow.id }, () => new Date('2027-05-01T11:00:00Z')))!
    expect((await getAgencyQuote(later, quote.id)).status).toBe('EXPIRED')
    await expect(offerQuote({ ...env.manager, now: () => new Date('2027-05-01T11:00:00Z') }, quote.id, { amountHalalas: 1, unit: 'PER_PERSON_NIGHT', vatIncluded: true })).rejects.toMatchObject({ code: 'QUOTE_NOT_OPEN', httpStatus: 409 })

    await db.update(priceQuote).set({ validUntil: new Date(Date.now() - 1000) }).where(eq(priceQuote.id, quote.id))
    await quoteExpiryJob.handle({}, { db: db as Database, jobId: 'test' })
    const [row] = await db.select().from(priceQuote).where(eq(priceQuote.id, quote.id))
    expect(row!.status).toBe('EXPIRED')
  })

  it('a quote of an inactive hotel can be read but not offered or declined (409 HOTEL_INACTIVE)', async () => {
    const env = await setup()
    const { quote } = await requestQuote(env.agency, request(env.hotel.id))
    await db.update(hotelTable).set({ status: 'INACTIVE' }).where(eq(hotelTable.id, env.hotel.id))
    expect((await getQuote(env.manager, quote.id)).id).toBe(quote.id)
    await expect(offerQuote(env.manager, quote.id, { amountHalalas: 1, unit: 'PER_PERSON_NIGHT', vatIncluded: true })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    await expect(declineQuote(env.manager, quote.id, { reason: 'Closed' })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
  })

  it('staff decline with a reason kept in the audit; a declined quote cannot be offered', async () => {
    const env = await setup()
    const { quote } = await requestQuote(env.agency, request(env.hotel.id))
    expect((await declineQuote(env.manager, quote.id, { reason: 'Fully booked' })).status).toBe('DECLINED')
    await expect(offerQuote(env.manager, quote.id, { amountHalalas: 1, unit: 'PER_PERSON_NIGHT', vatIncluded: true })).rejects.toMatchObject({ code: 'QUOTE_NOT_OPEN' })
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'QUOTE_DECLINED'))
    expect(audit).toMatchObject({ reason: 'Fully booked', entityId: quote.id })
  })

  it('staff see only quotes of hotels they can access; another hotel\'s quote is 404; offering needs quote.manage', async () => {
    const env = await setup()
    const otherHotel = await makeHotel(db, env.scope)
    const { quote } = await requestQuote(env.agency, request(otherHotel.id))
    const limited = staff(env.scope, env.manager.identity.userId, ['quote.manage', 'booking.view'], [env.hotel.id])
    expect((await listQuotes(limited, { page: 1, pageSize: 20 })).items).toEqual([])
    await expect(getQuote(limited, quote.id)).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND', httpStatus: 404 })
    await expect(offerQuote(staff(env.scope, env.manager.identity.userId, ['booking.view']), quote.id, { amountHalalas: 1, unit: 'PER_PERSON_NIGHT', vatIncluded: true })).rejects.toMatchObject({ httpStatus: 403 })
    // Staff read the agency by name (the quote desk has no agency list of its own).
    expect((await listQuotes(env.manager, { page: 1, pageSize: 20, status: 'REQUESTED' })).items.map(q => [q.id, q.agencyName])).toEqual([[quote.id, 'Al-Noor Travels']])
  })
})
