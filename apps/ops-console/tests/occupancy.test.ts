import { describe, expect, it } from 'vitest'
import type { OccupancyClaimDto, OccupancyDayViewDto, OccupancyRoomDto } from '@hajj/contracts/types/occupancy'
import { arrivalsOf, csvOf, departuresOf, fillTone, monthGrid, monthRange, roomMatches, shiftMonth } from '../app/utils/occupancy'

const claim = (over: Partial<OccupancyClaimDto> = {}): OccupancyClaimDto => ({
  bookingId: 'b1', bookingNo: 'B-2027-0001', status: 'CONFIRMED', bookingType: 'GROUP', booker: { agencyId: 'a1', name: 'Al-Noor' },
  occupancy: 'MALE', checkIn: '2027-06-01', checkOut: '2027-06-04', extraBeds: 0,
  guests: [{ guestId: 'g1', slotNo: 1, ageGroup: 'ADULT', status: 'READY', name: 'Karim', detailsComplete: true }, { guestId: 'g2', slotNo: 2, ageGroup: 'ADULT', status: 'PENDING_DETAILS', name: null, detailsComplete: false }],
  ...over,
})
const room = (over: Partial<OccupancyRoomDto> = {}): OccupancyRoomDto => ({
  roomId: 'r1', roomNumber: '101', roomType: { id: 't1', name: 'Quad' }, inventoryStatus: 'AVAILABLE', state: 'PARTIAL', capacity: 4, booked: 2, held: 0, claims: [claim()], ...over,
})

describe('the occupancy calendar (v7 §14)', () => {
  it('colours a day by how full it is: under half, up to nine tenths, beyond', () => {
    expect([fillTone(0), fillTone(49), fillTone(50), fillTone(90), fillTone(91)]).toEqual(['low', 'low', 'mid', 'mid', 'high'])
  })

  it('lays a month out in weeks from Sunday, empty cells around it', () => {
    const june = monthGrid('2027-06')
    expect(june[0]).toEqual([null, null, '2027-06-01', '2027-06-02', '2027-06-03', '2027-06-04', '2027-06-05'])
    expect(june.flat().filter(Boolean)).toHaveLength(30)
    expect(june.every(week => week.length === 7)).toBe(true)
    expect(monthRange('2027-02')).toEqual({ from: '2027-02-01', to: '2027-02-28' })
  })

  it('filters the day by agency (or individuals), side, state and room type', () => {
    expect(roomMatches(room(), { agency: 'a1', occupancy: 'MALE', state: 'PARTIAL', roomType: 't1' })).toBe(true)
    expect(roomMatches(room(), { agency: 'INDIVIDUAL' })).toBe(false)
    expect(roomMatches(room({ claims: [claim({ booker: { agencyId: null, name: null }, occupancy: 'FAMILY' })] }), { agency: 'INDIVIDUAL', occupancy: 'FAMILY' })).toBe(true)
    expect(roomMatches(room({ state: 'EMPTY', claims: [] }), { agency: 'a1' })).toBe(false)
    expect(roomMatches(room({ state: 'EMPTY', claims: [] }), { state: 'EMPTY' })).toBe(true)
  })

  it("lists the day's arrivals and departures once per booking, with how many details are missing", () => {
    const day = { date: '2027-06-01', floors: [{ id: 'f1', level: 1, label: '1', rooms: [room(), room({ roomId: 'r2', roomNumber: '102', claims: [claim({ guests: [claim().guests[0]!] })] })] }] } as unknown as OccupancyDayViewDto
    expect(arrivalsOf(day)).toEqual([{ bookingId: 'b1', bookingNo: 'B-2027-0001', booker: { agencyId: 'a1', name: 'Al-Noor' }, rooms: ['101', '102'], pilgrims: 3, detailsPending: 1, checkIn: '2027-06-01', checkOut: '2027-06-04' }])
    const night = { date: '2027-06-03', floors: day.floors } as unknown as OccupancyDayViewDto
    expect(arrivalsOf(night)).toEqual([])
    expect(departuresOf(night, '2027-06-04').map(d => d.bookingNo)).toEqual(['B-2027-0001'])
  })

  it('writes the day as a spreadsheet: one line per pilgrim, an empty room on its own line, quotes escaped', () => {
    const day = { date: '2027-06-01', floors: [{ id: 'f1', level: 1, label: 'Floor "1"', rooms: [room(), room({ roomId: 'r3', roomNumber: '103', state: 'EMPTY', booked: 0, claims: [] })] }] } as unknown as OccupancyDayViewDto
    const csv = csvOf(day, { header: ['Floor', 'Room', 'State', 'Taken', 'Places', 'Booking', 'Booked by', 'Pilgrim', 'Status'], state: s => s, status: s => s, individual: 'Individual', agency: 'Agency' })
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n')
    expect(lines[0]).toBe('Floor,Room,State,Taken,Places,Booking,Booked by,Pilgrim,Status')
    // Places taken and places as two numbers: "2/4" would read as a date in a spreadsheet.
    expect(lines[1]).toBe('"Floor ""1""",101,PARTIAL,2,4,B-2027-0001,Al-Noor,Karim,READY')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe('"Floor ""1""",103,EMPTY,0,4,,,,')
  })
})

describe('the day as a spreadsheet', () => {
  it('never lets a spreadsheet read a name as a formula', () => {
    const evil = room({ claims: [claim({ guests: [{ guestId: 'g', slotNo: 1, ageGroup: 'ADULT', status: 'READY', name: '=HYPERLINK("x")', detailsComplete: true }] })] })
    const day = { date: '2027-06-01', floors: [{ id: 'f1', level: 1, label: '1', rooms: [evil] }] } as unknown as OccupancyDayViewDto
    const line = csvOf(day, { header: ['h'], state: s => s, status: s => s, individual: 'I', agency: 'A' }).split('\r\n')[1]
    expect(line).toContain(`"'=HYPERLINK(""x"")"`)
  })
})

describe('stepping through months', () => {
  it('moves by whole months across a year', () => {
    expect([shiftMonth('2027-01', -1), shiftMonth('2027-12', 1), shiftMonth('2027-06', 0)]).toEqual(['2026-12', '2028-01', '2027-06'])
  })
})
