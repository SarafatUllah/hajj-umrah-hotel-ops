import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { otpChallenge } from '@hajj/db/schema'
import { hashOtpCode } from '../../server/security/otp'
import { makeStayHotel } from '../support/stayFixtures'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { closeTestDb, getHttpTestDb, makeOrg, truncateAllTables } from './support/fixtures'

const client = apiClient(inject('httpTestBaseUrl'))
const db = getHttpTestDb()
const LEAD = { fullName: 'Yusuf Rahman', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-03-01', passportNo: 'BG1234567', passportExpiry: '2030-01-01' }

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

const cookieOf = (setCookie: string[]) => setCookie.map(entry => entry.split(';')[0]).join('; ')

/** Signs a customer in through the real OTP verify route (the challenge is planted: the harness sends no SMS). */
async function signIn(organization: { id: string, slug: string }, phone: string, fullName: string): Promise<string> {
  const challengeId = randomUUID()
  await db.insert(otpChallenge).values({ id: challengeId, organizationId: organization.id, phone, codeHash: hashOtpCode(challengeId, '482913'), expiresAt: new Date(Date.now() + 300_000) })
  const res = await client.request('/api/customer/auth/otp/verify', { method: 'POST', body: { organizationSlug: organization.slug, challengeId, code: '482913', fullName } })
  expect(res.status).toBe(200)
  return cookieOf(res.setCookie)
}

describe('public booking API over HTTP (v7 §6, §10)', () => {
  it('hotels without a session; a signed-in customer searches, requests, lists and withdraws; another customer sees nothing', async () => {
    const { organization, scope } = await makeOrg(db)
    const { hotel } = await makeStayHotel(db, scope)
    const hotels = await client.request(`/api/public/hotels?organization=${organization.slug}`)
    expect(hotels.status).toBe(200)
    expect(hotels.json).toEqual([expect.objectContaining({ id: hotel.id, name: hotel.name })])

    const stay = { hotelId: hotel.id, bookingType: 'FAMILY', checkIn: '2027-06-01', checkOut: '2027-06-04', totalCount: 3 }
    expectStandardError(await client.request('/api/customer/stays/search', { method: 'POST', body: stay }), { status: 401 })
    const cookie = await signIn(organization, '+966501230001', 'Yusuf Rahman')
    const search = await client.request('/api/customer/stays/search', { method: 'POST', body: stay, cookie })
    expect(search.status).toBe(200)
    const rooms = search.json.options[0].rooms.map((r: { roomId: string, occupancy: string, seats: number, extraBeds: number }) => ({ roomId: r.roomId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds }))

    expectStandardError(await client.request('/api/customer/bookings', { method: 'POST', body: { ...stay, rooms, lead: { fullName: 'No Passport' } }, cookie }), { status: 422 })
    const requested = await client.request('/api/customer/bookings', { method: 'POST', body: { ...stay, rooms, lead: LEAD }, cookie })
    expect(requested.status).toBe(200)
    expect(requested.json).toMatchObject({ status: 'REQUESTED', priceSource: 'PUBLIC' })
    const id = requested.json.id as string

    expect((await client.request('/api/customer/bookings', { cookie })).json).toMatchObject({ total: 1, items: [{ id }] })
    const guests = await client.request(`/api/customer/bookings/${id}/guests`, { cookie })
    expect(guests.json[0]).toMatchObject({ status: 'READY', details: { fullName: 'Yusuf Rahman' } })
    expect(JSON.stringify(guests.json)).not.toContain('BG1234567')

    const stranger = await signIn(organization, '+966501230002', 'Someone Else')
    expectStandardError(await client.request(`/api/customer/bookings/${id}`, { cookie: stranger }), { status: 404, code: 'BOOKING_NOT_FOUND' })
    expectStandardError(await client.request(`/api/customer/bookings/${id}/withdraw`, { method: 'POST', cookie: stranger }), { status: 404 })

    const withdrawn = await client.request(`/api/customer/bookings/${id}/withdraw`, { method: 'POST', cookie })
    expect(withdrawn.json).toMatchObject({ status: 'CANCELLED' })
  })
})
