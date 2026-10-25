import { describe, expect, it } from 'vitest'
import { HOTEL_MARKER_HUES, hotelMarker } from '../app/utils/hotelMarker'

describe('the hotel marker (§6.5)', () => {
  it('reads the monogram from the last segment of the code', () => {
    expect(hotelMarker({ id: 'a', code: 'MKK-GRAND' }).monogram).toBe('GR')
    expect(hotelMarker({ id: 'a', code: 'MED-QUBA' }).monogram).toBe('QU')
    expect(hotelMarker({ id: 'a', code: 'AJYAD' }).monogram).toBe('AJ')
    expect(hotelMarker({ id: 'a', code: 'x' }).monogram).toBe('X')
  })

  it('picks the same hue for the same hotel every time, from the eight marker hues only', () => {
    const ids = ['c19411a1-4149-58e7-9c66-8af81c85d986', '7496fd24-3b00-54ea-bed1-52afe08c7dd2', 'a7351f9a-9328-5fec-9086-ff25b0fc1b91']
    for (const id of ids) {
      const { hue } = hotelMarker({ id, code: 'MKK-GRAND' })
      expect(hue).toBe(hotelMarker({ id, code: 'OTHER' }).hue)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(HOTEL_MARKER_HUES)
    }
    expect(new Set(ids.map(id => hotelMarker({ id, code: 'A' }).hue)).size).toBeGreaterThan(1)
  })
})
