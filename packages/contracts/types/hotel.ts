/** What the public site shows of a hotel (nothing internal: no code, settings, counts or contact data). */
export interface PublicHotel { id: string, name: string, city: string, country: string, address: string | null }
