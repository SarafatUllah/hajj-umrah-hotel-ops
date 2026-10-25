import { describe, expect, it } from 'vitest'
import type { AgencyQuotaDto, RateDto } from '@hajj/contracts/types/bookingRules'
import { EVERY_AGENCY, extraBedRequestOf, quotaFormOf, quotaRequestOf, rateFormOf, rateRequestOf, roomMixRequestOf, ruleConflictKey, sortedQuotas, sortedRates } from '../app/utils/bookingRules'

const STORED = { createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z' }
const rate = (id: string, roomTypeId: string, priceType: RateDto['priceType'], unit: RateDto['unit'], startDate: string): RateDto => ({ ...STORED, id, roomTypeId, priceType, unit, startDate, endDate: '2027-12-31', amountHalalas: 35000, vatIncluded: true })
const quota = (id: string, agencyId: string | null, startDate: string, agencyName: string | null = null): AgencyQuotaDto => ({ ...STORED, id, agencyId, agencyName, startDate, endDate: '2027-12-31', maxPersons: 30 })

describe('a rate form (v7 §8, §15)', () => {
  it('starts tonight, public, per person, VAT included, with no amount typed', () => {
    expect(rateFormOf(null, '2026-10-21')).toEqual({ roomTypeId: '', priceType: 'PUBLIC', unit: 'PER_PERSON_NIGHT', startDate: '2026-10-21', endDate: '', riyals: undefined, vatIncluded: true })
  })

  it('shows a rate in riyals and sends it in halalas; a cleared amount is nothing typed', () => {
    const form = rateFormOf(rate('r1', 't1', 'AGENCY_DEFAULT', 'PER_ROOM_NIGHT', '2027-01-01'), '2026-10-21')
    expect(form.riyals).toBe(350)
    expect(rateRequestOf({ ...form, riyals: 412.5 })).toMatchObject({ roomTypeId: 't1', priceType: 'AGENCY_DEFAULT', unit: 'PER_ROOM_NIGHT', amountHalalas: 41250 })
    expect(rateRequestOf({ ...form, riyals: null }).amountHalalas).toBeUndefined()
    expect(rateRequestOf({ ...form, riyals: Number.NaN }).amountHalalas).toBeUndefined()
  })
})

describe('an agency quota form (v7 §10)', () => {
  it('chooses every agency (the default) as its own choice, sent as no agency', () => {
    expect(quotaFormOf(null, '2026-10-21').agency).toBe(EVERY_AGENCY)
    expect(quotaFormOf(quota('q1', null, '2027-01-01'), '2026-10-21').agency).toBe(EVERY_AGENCY)
    expect(quotaRequestOf({ agency: EVERY_AGENCY, startDate: '2027-01-01', endDate: '2027-01-31', maxPersons: 30 })).toEqual({ agencyId: null, startDate: '2027-01-01', endDate: '2027-01-31', maxPersons: 30 })
    expect(quotaRequestOf({ agency: 'a1', startDate: '2027-01-01', endDate: '2027-01-31', maxPersons: null }).agencyId).toBe('a1')
  })
})

describe('a room-mix rule and an extra-bed policy', () => {
  it('an empty "up to" is no upper bound; other cleared numbers are nothing typed', () => {
    expect(roomMixRequestOf({ groupMin: 20, groupMax: null, minSeats: 5, maxRooms: 2 })).toEqual({ groupMin: 20, groupMax: null, minSeats: 5, maxRooms: 2 })
    expect(roomMixRequestOf({ groupMin: null, groupMax: undefined, minSeats: 5, maxRooms: 2 })).toEqual({ groupMin: undefined, groupMax: null, minSeats: 5, maxRooms: 2 })
  })

  it('an extra bed is priced in riyals and sent in halalas', () => {
    expect(extraBedRequestOf({ roomTypeId: 't1', maxPerRoom: 1, maxPerBooking: 2, riyals: 80, vatIncluded: true, allowInOverrideSeason: false })).toEqual({ roomTypeId: 't1', maxPerRoom: 1, maxPerBooking: 2, amountHalalas: 8000, vatIncluded: true, allowInOverrideSeason: false })
  })
})

describe('the rules in reading order, and a refused save', () => {
  it('rates by room type, public before the agency default, per person first, then by season', () => {
    const names: Record<string, string> = { t1: 'Quad', t2: 'Double' }
    const rates = [rate('a', 't1', 'AGENCY_DEFAULT', 'PER_PERSON_NIGHT', '2027-01-01'), rate('b', 't1', 'PUBLIC', 'PER_ROOM_NIGHT', '2027-01-01'), rate('c', 't1', 'PUBLIC', 'PER_PERSON_NIGHT', '2027-06-01'), rate('d', 't1', 'PUBLIC', 'PER_PERSON_NIGHT', '2027-01-01'), rate('e', 't2', 'PUBLIC', 'PER_PERSON_NIGHT', '2027-01-01')]
    expect(sortedRates(rates, id => names[id]!).map(r => r.id)).toEqual(['e', 'd', 'c', 'b', 'a'])
  })

  it('quotas: the default first, then by agency and season', () => {
    const quotas = [quota('x', 'a1', '2027-01-01', 'Al-Noor'), quota('y', null, '2027-06-01'), quota('z', 'a2', '2027-01-01', 'Al-Haramain'), quota('w', null, '2027-01-01')]
    expect(sortedQuotas(quotas, q => q.agencyName ?? 'Every agency').map(q => q.id)).toEqual(['w', 'y', 'z', 'x'])
  })

  it('an overlap or a duplicate is said for the rule kind; anything else is the usual message', () => {
    expect(ruleConflictKey('rates', 'RANGE_OVERLAP')).toBe('rules.rates.overlap')
    expect(ruleConflictKey('agency-quotas', 'RANGE_OVERLAP')).toBe('rules.quotas.overlap')
    expect(ruleConflictKey('allocation-rules', 'RANGE_OVERLAP')).toBe('rules.roomMix.overlap')
    expect(ruleConflictKey('extra-bed-policies', 'ALREADY_EXISTS')).toBe('rules.extraBeds.exists')
    expect(ruleConflictKey('rates', 'HOTEL_INACTIVE')).toBeNull()
  })
})
