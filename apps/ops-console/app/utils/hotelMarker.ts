/** How many marker hues there are (§8.4); they appear only in hotel monograms, never as status. */
export const HOTEL_MARKER_HUES = 8

/** A hotel's monogram tile (§6.5): two letters from the last segment of its code, a hue picked by its id. */
export interface HotelMarker { monogram: string, hue: number }

/** FNV-1a: a stable, well-spread hash of the id (the same hotel always gets the same hue). */
function hashOf(text: string): number {
  let hash = 0x811C9DC5
  for (const character of text) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function hotelMarker(hotel: { id: string, code: string }): HotelMarker {
  const lastSegment = hotel.code.split('-').filter(Boolean).at(-1) ?? hotel.code
  return { monogram: lastSegment.slice(0, 2).toUpperCase(), hue: hashOf(hotel.id) % HOTEL_MARKER_HUES }
}
