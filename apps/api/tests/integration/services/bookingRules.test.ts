import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auditLog, hotel as hotelTable } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { createBookingRule, deleteBookingRule, getBookingSettings, listBookingRules, updateBookingRule, updateBookingSettings } from '../../../server/services/booking'
import { makeAgency } from '../../support/bookingFixtures'
import { makeHotel, makeOrg, makeRoomType, makeUser } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

function ctxFor(scope: OrganizationScope, userId: string, permissions: Permission[], hotelIds: string[] = []): AuthContext {
  return {
    identity: { userId, organizationId: scope.organizationId, email: 'm@example.test', fullName: 'Manager' },
    authz: { permissions: new Set(permissions), allHotels: hotelIds.length === 0, hotelIds: new Set(hotelIds) },
    scope,
    db: db as Database,
    now: () => new Date(),
  }
}

async function setup() {
  const { scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope)
  const roomType = await makeRoomType(db, scope)
  const user = await makeUser(db, scope)
  return {
    scope,
    hotel,
    roomType,
    manager: ctxFor(scope, user.id, ['rate.view', 'rate.manage', 'booking.view', 'booking.settings']),
    viewer: ctxFor(scope, user.id, ['rate.view', 'booking.view']),
  }
}

const rate = (roomTypeId: string, overrides: Record<string, unknown> = {}) => ({ roomTypeId, priceType: 'PUBLIC', unit: 'PER_PERSON_NIGHT', startDate: '2027-06-01', endDate: '2027-06-30', amountHalalas: 38000, vatIncluded: true, ...overrides })

describe('booking rules (rates, quotas, room-mix rules, extra-bed policies)', () => {
  it('rates: create, list, edit (merged and re-validated), delete — each audited; reading needs rate.view, changing rate.manage', async () => {
    const env = await setup()
    const created = await createBookingRule(env.manager, env.hotel.id, 'rates', rate(env.roomType.id))
    expect(created).toMatchObject({ amountHalalas: 38000, startDate: '2027-06-01', createdAt: expect.any(String) })
    expect(created).not.toHaveProperty('organizationId')
    expect(await listBookingRules(env.viewer, env.hotel.id, 'rates')).toEqual([created])
    await expect(createBookingRule(env.viewer, env.hotel.id, 'rates', rate(env.roomType.id, { startDate: '2027-08-01', endDate: '2027-08-31' }))).rejects.toMatchObject({ httpStatus: 403 })

    expect(await updateBookingRule(env.manager, env.hotel.id, 'rates', created.id, { amountHalalas: 35000 })).toMatchObject({ amountHalalas: 35000, startDate: '2027-06-01' })
    await expect(updateBookingRule(env.manager, env.hotel.id, 'rates', created.id, { endDate: '2027-05-01' })).rejects.toMatchObject({ name: 'ZodError' })
    expect(await deleteBookingRule(env.manager, env.hotel.id, 'rates', created.id)).toEqual({ id: created.id })
    await expect(deleteBookingRule(env.manager, env.hotel.id, 'rates', created.id)).rejects.toMatchObject({ code: 'BOOKING_RULE_NOT_FOUND', httpStatus: 404 })

    const actions = (await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'rate'), eq(auditLog.entityId, created.id)))).map(a => a.action).sort()
    expect(actions).toEqual(['BOOKING_RULE_CREATED', 'BOOKING_RULE_DELETED', 'BOOKING_RULE_UPDATED'])
  })

  it('overlapping seasons or group sizes are 409 RANGE_OVERLAP; a second extra-bed policy for a room type is 409 ALREADY_EXISTS', async () => {
    const env = await setup()
    await createBookingRule(env.manager, env.hotel.id, 'rates', rate(env.roomType.id))
    await expect(createBookingRule(env.manager, env.hotel.id, 'rates', rate(env.roomType.id, { startDate: '2027-06-30', endDate: '2027-07-10' }))).rejects.toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })
    await createBookingRule(env.manager, env.hotel.id, 'rates', rate(env.roomType.id, { priceType: 'AGENCY_DEFAULT', amountHalalas: 35000 }))

    await createBookingRule(env.manager, env.hotel.id, 'allocation-rules', { groupMin: 1, groupMax: 10, minSeats: 5, maxRooms: 1 })
    await expect(createBookingRule(env.manager, env.hotel.id, 'allocation-rules', { groupMin: 10, groupMax: null, minSeats: 5, maxRooms: 2 })).rejects.toMatchObject({ code: 'RANGE_OVERLAP' })

    const policy = { roomTypeId: env.roomType.id, maxPerRoom: 1, maxPerBooking: 2, amountHalalas: 8000, vatIncluded: true, allowInOverrideSeason: false }
    await createBookingRule(env.manager, env.hotel.id, 'extra-bed-policies', policy)
    await expect(createBookingRule(env.manager, env.hotel.id, 'extra-bed-policies', policy)).rejects.toMatchObject({ code: 'ALREADY_EXISTS', httpStatus: 409 })
  })

  it('quotas: the default row (agencyId null) and an agency\'s own row coexist, each naming its agency; another organization\'s agency or room type is 422', async () => {
    const env = await setup()
    const agency = await makeAgency(db, env.scope)
    const season = { startDate: '2027-06-01', endDate: '2027-06-30' }
    expect(await createBookingRule(env.manager, env.hotel.id, 'agency-quotas', { agencyId: null, ...season, maxPersons: 30 })).toMatchObject({ agencyId: null, agencyName: null })
    expect(await createBookingRule(env.manager, env.hotel.id, 'agency-quotas', { agencyId: agency.id, ...season, maxPersons: 40 })).toMatchObject({ agencyId: agency.id, agencyName: agency.name })
    const quotas = await listBookingRules(env.viewer, env.hotel.id, 'agency-quotas')
    expect(quotas.map(q => q.agencyName).sort()).toEqual([agency.name, null].sort())

    const other = await setup()
    const foreignAgency = await makeAgency(db, other.scope)
    await expect(createBookingRule(env.manager, env.hotel.id, 'agency-quotas', { agencyId: foreignAgency.id, startDate: '2027-07-01', endDate: '2027-07-30', maxPersons: 5 })).rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })
    await expect(createBookingRule(env.manager, env.hotel.id, 'rates', rate(other.roomType.id))).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })
  })

  it('PATCH on every kind: stored nulls survive, nulls can be set, an unknown key is refused, a no-op writes nothing, an overlap is 409', async () => {
    const env = await setup()
    const agency = await makeAgency(db, env.scope)
    const quota = await createBookingRule(env.manager, env.hotel.id, 'agency-quotas', { agencyId: null, startDate: '2027-06-01', endDate: '2027-06-30', maxPersons: 30 })
    expect(await updateBookingRule(env.manager, env.hotel.id, 'agency-quotas', quota.id, { maxPersons: 35 })).toMatchObject({ agencyId: null, maxPersons: 35 })
    expect(await updateBookingRule(env.manager, env.hotel.id, 'agency-quotas', quota.id, { agencyId: agency.id })).toMatchObject({ agencyId: agency.id, agencyName: agency.name })

    const rule = await createBookingRule(env.manager, env.hotel.id, 'allocation-rules', { groupMin: 1, groupMax: 10, minSeats: 5, maxRooms: 1 })
    await createBookingRule(env.manager, env.hotel.id, 'allocation-rules', { groupMin: 21, groupMax: 30, minSeats: 5, maxRooms: 3 })
    await expect(updateBookingRule(env.manager, env.hotel.id, 'allocation-rules', rule.id, { groupMax: null })).rejects.toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })
    expect(await updateBookingRule(env.manager, env.hotel.id, 'allocation-rules', rule.id, { groupMax: 20 })).toMatchObject({ groupMax: 20 })
    await expect(updateBookingRule(env.manager, env.hotel.id, 'allocation-rules', rule.id, { hotelId: env.hotel.id })).rejects.toMatchObject({ name: 'ZodError' })

    const policy = await createBookingRule(env.manager, env.hotel.id, 'extra-bed-policies', { roomTypeId: env.roomType.id, maxPerRoom: 1, maxPerBooking: 2, amountHalalas: 8000, vatIncluded: true, allowInOverrideSeason: false })
    const updates = () => db.select().from(auditLog).where(and(eq(auditLog.entityId, policy.id), eq(auditLog.action, 'BOOKING_RULE_UPDATED')))
    await updateBookingRule(env.manager, env.hotel.id, 'extra-bed-policies', policy.id, { amountHalalas: 8000 })
    expect(await updates()).toHaveLength(0)
    await updateBookingRule(env.manager, env.hotel.id, 'extra-bed-policies', policy.id, { amountHalalas: 9000 })
    expect(await updates()).toEqual([expect.objectContaining({ beforeData: expect.objectContaining({ amountHalalas: 8000 }), afterData: expect.objectContaining({ amountHalalas: 9000 }) })])
  })

  it('permissions are per kind: rates need rate.*, the other rules booking.view / booking.settings', async () => {
    const env = await setup()
    const ratesOnly = ctxFor(env.scope, env.manager.identity.userId, ['rate.view', 'rate.manage'])
    const settingsOnly = ctxFor(env.scope, env.manager.identity.userId, ['booking.view', 'booking.settings'])
    await createBookingRule(ratesOnly, env.hotel.id, 'rates', rate(env.roomType.id))
    await expect(listBookingRules(settingsOnly, env.hotel.id, 'rates')).rejects.toMatchObject({ httpStatus: 403 })
    await expect(createBookingRule(ratesOnly, env.hotel.id, 'allocation-rules', { groupMin: 1, groupMax: 10, minSeats: 5, maxRooms: 1 })).rejects.toMatchObject({ httpStatus: 403 })
    await createBookingRule(settingsOnly, env.hotel.id, 'allocation-rules', { groupMin: 1, groupMax: 10, minSeats: 5, maxRooms: 1 })
  })

  it('an inactive hotel\'s rules can be read but not changed', async () => {
    const env = await setup()
    const created = await createBookingRule(env.manager, env.hotel.id, 'rates', rate(env.roomType.id))
    await db.update(hotelTable).set({ status: 'INACTIVE' }).where(eq(hotelTable.id, env.hotel.id))
    expect(await listBookingRules(env.viewer, env.hotel.id, 'rates')).toHaveLength(1)
    await expect(updateBookingRule(env.manager, env.hotel.id, 'rates', created.id, { amountHalalas: 1 })).rejects.toMatchObject({ httpStatus: 409 })
  })

  it('a hotel the caller cannot access is 404 for every rule route', async () => {
    const env = await setup()
    const otherHotel = await makeHotel(db, env.scope)
    const limited = ctxFor(env.scope, env.manager.identity.userId, ['rate.view', 'rate.manage'], [env.hotel.id])
    await expect(listBookingRules(limited, otherHotel.id, 'rates')).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND', httpStatus: 404 })
    await expect(createBookingRule(limited, otherHotel.id, 'rates', rate(env.roomType.id))).rejects.toMatchObject({ httpStatus: 404 })
  })
})

describe('booking settings', () => {
  it('reading creates the defaults (v7 §15); a change is audited with only the changed fields; a no-op writes nothing', async () => {
    const env = await setup()
    expect(await getBookingSettings(env.viewer)).toMatchObject({ holdMinutes: 10, requestHours: 24, quoteValidityHours: 48, individualMaxRooms: 5, childAgeLimit: 10, infantAgeLimit: 2, childDefaultSide: 'MOTHER', whatsappNumber: null })

    const updated = await updateBookingSettings(env.manager, { holdMinutes: 15, whatsappNumber: '966512345678' })
    expect(updated).toMatchObject({ holdMinutes: 15, whatsappNumber: '966512345678' })
    await updateBookingSettings(env.manager, { holdMinutes: 15 })
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'BOOKING_SETTINGS_CHANGED'))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ beforeData: { holdMinutes: 10, whatsappNumber: null }, afterData: { holdMinutes: 15, whatsappNumber: '966512345678' } })
  })

  it('needs booking.settings and access to every hotel to change; the infant age must stay at or below the child age', async () => {
    const env = await setup()
    await expect(updateBookingSettings(env.viewer, { holdMinutes: 20 })).rejects.toMatchObject({ httpStatus: 403 })
    const hotelScoped = ctxFor(env.scope, env.manager.identity.userId, ['booking.view', 'booking.settings'], [env.hotel.id])
    await expect(updateBookingSettings(hotelScoped, { holdMinutes: 20 })).rejects.toMatchObject({ httpStatus: 403 })
    await expect(updateBookingSettings(env.manager, { infantAgeLimit: 5, childAgeLimit: 4 })).rejects.toMatchObject({ code: 'INVALID_AGE_LIMITS', httpStatus: 422 })
  })
})
