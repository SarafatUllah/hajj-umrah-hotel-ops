import { describe, expect, it } from 'vitest'
import { defaultUnitFor, highestPublicRate, isUnpriced, priceStay, type RateRule, unitPriceFor } from '../../../../server/domain/booking/pricing'

const rate = (overrides: Partial<RateRule> = {}): RateRule => ({ roomTypeId: 'quad', priceType: 'PUBLIC', unit: 'PER_PERSON_NIGHT', startDate: '2027-06-01', endDate: '2027-06-30', amountHalalas: 38000, vatIncluded: true, ...overrides })
const rates = [rate(), rate({ priceType: 'AGENCY_DEFAULT', amountHalalas: 35000 }), rate({ roomTypeId: 'double', amountHalalas: 45000 })]

describe('unitPriceFor (v7 §8: quote → agency default → public)', () => {
  const base = { night: '2027-06-10', roomTypeId: 'quad', unit: 'PER_PERSON_NIGHT' as const, rates }

  it('a quote wins over every rate', () => {
    expect(unitPriceFor({ ...base, quote: { amountHalalas: 33000, unit: 'PER_PERSON_NIGHT', vatIncluded: false }, agencyDefault: true })).toEqual({ source: 'QUOTE', amountHalalas: 33000, vatIncluded: false })
  })

  it('an agency gets the agency default; anyone else, or a night without it, the public rate', () => {
    expect(unitPriceFor({ ...base, quote: null, agencyDefault: true })).toEqual({ source: 'AGENCY_DEFAULT', amountHalalas: 35000, vatIncluded: true })
    expect(unitPriceFor({ ...base, quote: null, agencyDefault: false })).toEqual({ source: 'PUBLIC', amountHalalas: 38000, vatIncluded: true })
    expect(unitPriceFor({ ...base, roomTypeId: 'double', quote: null, agencyDefault: true })).toMatchObject({ source: 'PUBLIC', amountHalalas: 45000 })
  })

  it('no rate for the night, room type or unit: null', () => {
    expect(unitPriceFor({ ...base, night: '2027-07-01', quote: null, agencyDefault: false })).toBeNull()
    expect(unitPriceFor({ ...base, unit: 'PER_ROOM_NIGHT', quote: null, agencyDefault: false })).toBeNull()
  })

  it('GROUP is priced per person, FAMILY per room', () => {
    expect(defaultUnitFor('GROUP')).toBe('PER_PERSON_NIGHT')
    expect(defaultUnitFor('FAMILY')).toBe('PER_ROOM_NIGHT')
  })
})

describe('priceStay', () => {
  const stay = { checkIn: '2027-06-29', checkOut: '2027-07-01', quote: null, agencyDefault: false, extraBedPrices: [{ roomTypeId: 'quad', amountHalalas: 8000, vatIncluded: true }] }
  const julyRates = [...rates, rate({ startDate: '2027-07-01', endDate: '2027-07-31', amountHalalas: 30000 })]

  it('per person: seated pilgrims of each room type × the night\'s price (empty seats never charged); extra beds apart', () => {
    const priced = priceStay({ ...stay, unit: 'PER_PERSON_NIGHT', rates: julyRates, rooms: [{ roomTypeId: 'quad', seats: 3, extraBeds: 1 }, { roomTypeId: 'quad', seats: 4, extraBeds: 0 }] })
    expect(isUnpriced(priced)).toBe(false)
    if (isUnpriced(priced)) return
    expect(priced.lines).toEqual([
      { night: '2027-06-29', kind: 'PERSON', roomTypeId: 'quad', quantity: 7, unitAmountHalalas: 38000, amountHalalas: 266000, vatIncluded: true },
      { night: '2027-06-29', kind: 'EXTRA_BED', roomTypeId: 'quad', quantity: 1, unitAmountHalalas: 8000, amountHalalas: 8000, vatIncluded: true },
      { night: '2027-06-30', kind: 'PERSON', roomTypeId: 'quad', quantity: 7, unitAmountHalalas: 38000, amountHalalas: 266000, vatIncluded: true },
      { night: '2027-06-30', kind: 'EXTRA_BED', roomTypeId: 'quad', quantity: 1, unitAmountHalalas: 8000, amountHalalas: 8000, vatIncluded: true },
    ])
    expect(priced).toMatchObject({ totalHalalas: 548000, source: 'PUBLIC' })
  })

  it('a stay across two seasons takes each night\'s own price; per room counts rooms', () => {
    const priced = priceStay({ ...stay, checkIn: '2027-06-30', checkOut: '2027-07-02', unit: 'PER_ROOM_NIGHT', rates: [rate({ unit: 'PER_ROOM_NIGHT', amountHalalas: 120000 }), rate({ unit: 'PER_ROOM_NIGHT', startDate: '2027-07-01', endDate: '2027-07-31', amountHalalas: 90000 })], rooms: [{ roomTypeId: 'quad', seats: 2, extraBeds: 0 }, { roomTypeId: 'quad', seats: 3, extraBeds: 0 }] })
    expect(isUnpriced(priced) ? null : priced.lines.map(l => [l.night, l.quantity, l.unitAmountHalalas])).toEqual([['2027-06-30', 2, 120000], ['2027-07-01', 2, 90000]])
  })

  it('a quote prices every night and room type; an agency default makes the source AGENCY_DEFAULT', () => {
    const quoted = priceStay({ ...stay, unit: 'PER_PERSON_NIGHT', rates: [], quote: { amountHalalas: 35000, unit: 'PER_PERSON_NIGHT', vatIncluded: true }, rooms: [{ roomTypeId: 'quad', seats: 2, extraBeds: 0 }] })
    expect(quoted).toMatchObject({ source: 'QUOTE', totalHalalas: 140000 })
    expect(priceStay({ ...stay, checkOut: '2027-06-30', unit: 'PER_PERSON_NIGHT', rates, agencyDefault: true, rooms: [{ roomTypeId: 'quad', seats: 1, extraBeds: 0 }] })).toMatchObject({ source: 'AGENCY_DEFAULT', totalHalalas: 35000 })
  })

  it('the quote\'s unit wins over the booking type\'s default (a FAMILY quoted per person is charged per person)', () => {
    const priced = priceStay({ ...stay, checkOut: '2027-06-30', unit: 'PER_ROOM_NIGHT', rates: [], quote: { amountHalalas: 30000, unit: 'PER_PERSON_NIGHT', vatIncluded: true }, rooms: [{ roomTypeId: 'quad', seats: 3, extraBeds: 0 }, { roomTypeId: 'quad', seats: 2, extraBeds: 0 }] })
    expect(isUnpriced(priced) ? null : priced.lines).toEqual([{ night: '2027-06-29', kind: 'PERSON', roomTypeId: 'quad', quantity: 5, unitAmountHalalas: 30000, amountHalalas: 150000, vatIncluded: true }])
  })

  it('a room type with nobody to charge needs no price (e.g. only infants in it)', () => {
    const priced = priceStay({ ...stay, checkOut: '2027-06-30', unit: 'PER_PERSON_NIGHT', rates, rooms: [{ roomTypeId: 'quad', seats: 2, extraBeds: 0 }, { roomTypeId: 'suite', seats: 0, extraBeds: 0 }] })
    expect(priced).toMatchObject({ totalHalalas: 76000, source: 'PUBLIC' })
  })

  it('a night without a price, or an extra bed without a policy, leaves the whole stay unpriced (with what is missing)', () => {
    const unpriced = priceStay({ ...stay, checkOut: '2027-07-02', unit: 'PER_PERSON_NIGHT', rates, rooms: [{ roomTypeId: 'quad', seats: 2, extraBeds: 0 }, { roomTypeId: 'double', seats: 2, extraBeds: 1 }] })
    expect(unpriced).toEqual({ missing: [
      { night: '2027-06-29', roomTypeId: 'double', kind: 'EXTRA_BED' },
      { night: '2027-06-30', roomTypeId: 'double', kind: 'EXTRA_BED' },
      { night: '2027-07-01', roomTypeId: 'double', kind: 'RATE' },
      { night: '2027-07-01', roomTypeId: 'double', kind: 'EXTRA_BED' },
      { night: '2027-07-01', roomTypeId: 'quad', kind: 'RATE' },
    ] })
  })
})

describe('highestPublicRate', () => {
  it('the highest public rate of the unit on any night of the stay, or null', () => {
    expect(highestPublicRate(rates, 'PER_PERSON_NIGHT', '2027-06-29', '2027-07-02')).toBe(45000)
    expect(highestPublicRate(rates, 'PER_ROOM_NIGHT', '2027-06-29', '2027-07-02')).toBeNull()
    expect(highestPublicRate(rates, 'PER_PERSON_NIGHT', '2027-07-01', '2027-07-05')).toBeNull()
  })
})
