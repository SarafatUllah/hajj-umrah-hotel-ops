import { describe, expect, it } from 'vitest'
import { findBookingMisfits, type NightSeats, type RoomClaim } from '../../../../server/domain/booking/inventoryFit'
import type { RoomCalendarInput } from '../../../../server/domain/inventory/calendar'

const options = { maintenanceBlocksSales: true }
const window = { from: '2027-06-01', to: '2027-06-10' }

/** A 4-seat room in inventory from 2027-01-01 (optionally retired after `lastNight`). */
const room = (overrides: Partial<RoomCalendarInput> = {}, lastNight: string | null = null): RoomCalendarInput => ({
  roomId: 'r1',
  versions: [{ validFrom: '2027-01-01', validTo: lastNight, physicalBeds: 4, sellableCapacity: 4 }],
  overrides: [],
  blocks: [],
  ...overrides,
})
const claim = (overrides: Partial<RoomClaim> = {}): RoomClaim => ({ bookingId: 'b1', bookingNo: 'B-1', roomId: 'r1', checkIn: '2027-06-03', checkOut: '2027-06-06', extraBeds: 0, ...overrides })
const seats = (n: number, nights: string[], roomId = 'r1'): NightSeats[] => nights.map(night => ({ roomId, night, seatsUsed: n }))
const NIGHTS = ['2027-06-03', '2027-06-04', '2027-06-05']

describe('findBookingMisfits', () => {
  it('a claim within capacity on sellable nights fits', () => {
    expect(findBookingMisfits([room()], [claim()], seats(4, NIGHTS), window, options)).toEqual([])
  })

  it('a retired room: the claim no longer sellable from the first retired night', () => {
    expect(findBookingMisfits([room({}, '2027-06-03')], [claim()], seats(2, NIGHTS), window, options))
      .toEqual([{ bookingId: 'b1', bookingNo: 'B-1', roomId: 'r1', from: '2027-06-04', to: '2027-06-05', reason: 'NOT_SELLABLE' }])
  })

  it('a sale-blocking block on a claimed night; a non-blocking maintenance block is fine', () => {
    const blocked = room({ blocks: [{ id: 'k', kind: 'MAINTENANCE', from: '2027-06-05', to: '2027-06-09' }] })
    expect(findBookingMisfits([blocked], [claim()], seats(1, NIGHTS), window, options)).toMatchObject([{ from: '2027-06-05', to: '2027-06-05', reason: 'NOT_SELLABLE' }])
    expect(findBookingMisfits([blocked], [claim()], seats(1, NIGHTS), window, { maintenanceBlocksSales: false })).toEqual([])
  })

  it('a capacity drop below the seated pilgrims is over capacity; extra beds count as capacity', () => {
    const smaller = room({ overrides: [{ periodId: 'p', validFrom: '2027-06-04', validTo: '2027-06-04', physicalBeds: 3, sellableCapacity: 3 }] })
    expect(findBookingMisfits([smaller], [claim()], seats(4, NIGHTS), window, options)).toMatchObject([{ from: '2027-06-04', to: '2027-06-04', reason: 'OVER_CAPACITY' }])
    expect(findBookingMisfits([smaller], [claim({ extraBeds: 1 })], seats(4, NIGHTS), window, options)).toEqual([])
  })

  it('extra beds of two claims on one room add up; every claim of an overfull room-night is reported', () => {
    const claims = [claim(), claim({ bookingId: 'b2', bookingNo: 'B-2', extraBeds: 1 })]
    expect(findBookingMisfits([room()], claims, seats(5, NIGHTS), window, options)).toEqual([])
    expect(findBookingMisfits([room()], claims, seats(6, NIGHTS), window, options).map(m => m.bookingNo)).toEqual(['B-1', 'B-2'])
  })

  it('only nights inside the window are judged; a room missing from the inputs is never sellable', () => {
    const late = claim({ checkIn: '2027-06-09', checkOut: '2027-06-15' })
    expect(findBookingMisfits([room({}, '2027-06-09')], [late], seats(1, ['2027-06-09', '2027-06-10', '2027-06-11']), window, options))
      .toMatchObject([{ from: '2027-06-10', to: '2027-06-10', reason: 'NOT_SELLABLE' }])
    expect(findBookingMisfits([], [claim()], [], window, options)).toMatchObject([{ from: '2027-06-03', to: '2027-06-05', reason: 'NOT_SELLABLE' }])
  })

  it('reports one entry per run of consecutive nights with the same reason', () => {
    const r = room({
      overrides: [{ periodId: 'p', validFrom: '2027-06-03', validTo: '2027-06-03', physicalBeds: 1, sellableCapacity: 1 }],
      blocks: [{ id: 'k', kind: 'OUT_OF_SERVICE', from: '2027-06-05', to: '2027-06-05' }],
    })
    expect(findBookingMisfits([r], [claim()], seats(2, NIGHTS), window, options).map(m => [m.from, m.to, m.reason])).toEqual([
      ['2027-06-03', '2027-06-03', 'OVER_CAPACITY'],
      ['2027-06-05', '2027-06-05', 'NOT_SELLABLE'],
    ])
  })

  it('a claim with no seated pilgrim still needs the room sellable (it holds the room for its owner)', () => {
    expect(findBookingMisfits([room({}, '2027-06-02')], [claim()], [], window, options)).toMatchObject([{ reason: 'NOT_SELLABLE' }])
  })
})
