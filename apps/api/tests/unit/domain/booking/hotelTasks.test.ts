import { describe, expect, it } from 'vitest'
import { extraBedTasks } from '../../../../server/domain/booking/hotelTasks'

describe('extraBedTasks (v7 §11)', () => {
  it('each claim with extra beds gets a set-up by its first night and a removal on its departure day', () => {
    expect(extraBedTasks([
      { roomId: 'r1', extraBeds: 1, checkIn: '2027-06-01', checkOut: '2027-06-04', status: 'CONFIRMED' },
      { roomId: 'r2', extraBeds: 0, checkIn: '2027-06-01', checkOut: '2027-06-04', status: 'CONFIRMED' },
    ])).toEqual([
      { roomId: 'r1', kind: 'EXTRA_BED_SETUP', quantity: 1, dueDate: '2027-06-01' },
      { roomId: 'r1', kind: 'EXTRA_BED_REMOVAL', quantity: 1, dueDate: '2027-06-04' },
    ])
  })

  it('a released claim (its pilgrims moved or removed before the confirmation) gives the hotel no work', () => {
    expect(extraBedTasks([{ roomId: 'r1', extraBeds: 2, checkIn: '2027-06-01', checkOut: '2027-06-04', status: 'RELEASED' }])).toEqual([])
  })
})
