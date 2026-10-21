import type { DbOrTx } from '@hajj/db/client'
import { addDays, type IsoDate, toEpochDay } from '@hajj/contracts/utils/dates'
import { normalizeEmail } from '@hajj/contracts/utils/email'
import { accountsRepos, bookingRepos } from '../../../server/repositories'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import { DEMO_HOTELS, type DemoRoomTypeCode } from '../../../server/demo/catalog'
import { demoIds } from './ids'

/** How long the demo's rates run from the anchor date (a season and the next one's sales). */
export const DEMO_RATE_WINDOW_DAYS = 540

/** The public price per person and night of each room type (SAR, before a hotel's own level). */
const PER_PERSON_SAR: Readonly<Record<DemoRoomTypeCode, number>> = { TRIPLE: 420, QUAD: 380, QUINT: 340, SIX_BED: 300 }
/** The public price per room and night (families book whole rooms). */
const PER_ROOM_SAR: Readonly<Record<DemoRoomTypeCode, number>> = { TRIPLE: 1150, QUAD: 1350, QUINT: 1500, SIX_BED: 1650 }
/** An agency's default price: below the public one (v7 §8: agencies bring many pilgrims). */
const AGENCY_SHARE = 0.92
/** Each hotel's price level (closer to the Haram costs more). */
const HOTEL_LEVEL: Readonly<Record<string, number>> = { 'MKK-GRAND': 1.25, 'MKK-AJYAD': 1.1, 'MKK-AZIZ': 0.85, 'MED-CENT': 1, 'MED-QUBA': 0.9 }

const HALALAS_PER_SAR = 100
const MS_PER_DAY = 86_400_000
/** Whole riyals, in halalas. */
const halalas = (sar: number): number => Math.round(sar) * HALALAS_PER_SAR

/** The demo agency the portal is shown with (approved; its user signs in with the demo password). */
export const DEMO_AGENCY = {
  key: 'al-noor',
  name: 'Al-Noor Travels',
  licenseNo: 'HU-2027-0142',
  contactName: 'Hamid Al-Noor',
  phone: '+966501110142',
  email: 'office@alnoor-travels.demo',
  whatsappNumber: '+966501110142',
  user: { key: 'al-noor-bookings', email: 'bookings@alnoor-travels.demo', fullName: 'Hamid Al-Noor' },
} as const

export interface DemoPricingSummary { rates: number, agencies: number, agencyUsers: number }

/**
 * Phase 2 demo data: every hotel's rates for the room types it has — public per person and per room, the agency
 * default per person — from the anchor date over `DEMO_RATE_WINDOW_DAYS`, and one approved agency with a user, so
 * the booking platform can be shown end to end (search, quote, hold, request). Same ids on every seed.
 */
export async function seedDemoPricing(tx: DbOrTx, scope: OrganizationScope, input: { anchorDate: IsoDate, passwordHash: string, approvedBy: string }): Promise<DemoPricingSummary> {
  const season = { startDate: input.anchorDate, endDate: addDays(input.anchorDate, DEMO_RATE_WINDOW_DAYS), vatIncluded: true }
  let rates = 0
  for (const hotel of DEMO_HOTELS) {
    const level = HOTEL_LEVEL[hotel.code] ?? 1
    const repos = bookingRepos(tx, trustedHotelScope(scope, demoIds.hotel(hotel.code)))
    const types = (Object.keys(hotel.distribution) as DemoRoomTypeCode[]).filter(type => hotel.distribution[type] > 0)
    for (const type of types) {
      const roomTypeId = demoIds.roomType(type)
      const rows = [
        { priceType: 'PUBLIC', unit: 'PER_PERSON_NIGHT', sar: PER_PERSON_SAR[type] * level },
        { priceType: 'PUBLIC', unit: 'PER_ROOM_NIGHT', sar: PER_ROOM_SAR[type] * level },
        { priceType: 'AGENCY_DEFAULT', unit: 'PER_PERSON_NIGHT', sar: PER_PERSON_SAR[type] * level * AGENCY_SHARE },
      ] as const
      for (const row of rows) {
        await repos.rates.insert({ id: demoIds.rate(hotel.code, type, row.priceType, row.unit), roomTypeId, priceType: row.priceType, unit: row.unit, amountHalalas: halalas(row.sar), ...season })
        rates += 1
      }
    }
  }

  const accounts = accountsRepos(tx, scope)
  const agencyId = demoIds.agency(DEMO_AGENCY.key)
  await accounts.agencies.insert({
    id: agencyId,
    name: DEMO_AGENCY.name,
    licenseNo: DEMO_AGENCY.licenseNo,
    contactName: DEMO_AGENCY.contactName,
    phone: DEMO_AGENCY.phone,
    email: normalizeEmail(DEMO_AGENCY.email),
    whatsappNumber: DEMO_AGENCY.whatsappNumber,
    status: 'APPROVED',
    approvedAt: new Date(toEpochDay(input.anchorDate) * MS_PER_DAY),
    approvedBy: input.approvedBy,
  })
  await accounts.agencyUsers.insert({ id: demoIds.agencyUser(DEMO_AGENCY.user.key), agencyId, email: normalizeEmail(DEMO_AGENCY.user.email), passwordHash: input.passwordHash, fullName: DEMO_AGENCY.user.fullName })
  return { rates, agencies: 1, agencyUsers: 1 }
}
