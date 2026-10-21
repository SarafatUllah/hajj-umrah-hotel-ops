import type { ChildSide } from '@hajj/contracts/constants/booking'
import type { PriceUnit } from '@hajj/contracts/constants/pricing'
import type { StaySearchInput } from '@hajj/contracts/schemas/booking'
import { eachDate, type IsoDate } from '@hajj/contracts/utils/dates'
import type { MixRule, PlannerInput, PlannerRoom, StayHeadcount } from '../../domain/booking/allocation/planner'
import { describeStayRooms, type StayRoom, stayNights } from '../../domain/booking/allocation/stayRooms'
import { defaultUnitFor, type ExtraBedPrice, type QuoteTerms, type RateRule, unitPriceFor } from '../../domain/booking/pricing'
import { ValidationError } from '../../errors/domainError'
import { bookingRepos, hotelRepos } from '../../repositories'
import type { BookingSettingRow } from '../../repositories/booking'
import type { HotelScope } from '../../security/scope'
import { calendarOptionsFor } from '../calendarOptions'
import { toRateRule } from './pricingRows'

/** The database handle a repository accepts (a service may not import db/client itself). */
type Db = Parameters<typeof bookingRepos>[0]

/** Who is booking (v7 §6): an agency (its own user, or staff on its behalf), or an individual customer. */
export type Booker =
  | { kind: 'AGENCY', agencyId: string, agencyUserId: string | null, staffUserId: string | null }
  | { kind: 'INDIVIDUAL', customerId: string }

/** The `booking_room.owner_key` of an agency's claims. */
export const agencyOwnerKey = (agencyId: string): string => `a:${agencyId}`

/** What prices a stay (v7 §8). */
export interface StayPricing { unit: PriceUnit, rates: RateRule[], quote: QuoteTerms | null, agencyDefault: boolean, extraBedPrices: ExtraBedPrice[] }

export interface StayFacts {
  /** The planner's input: the rooms that can be priced, with their ranking price. */
  planner: PlannerInput
  pricing: StayPricing
  /** Every loaded room by id. */
  rooms: ReadonlyMap<string, StayRoom>
}

/**
 * The head count as the allocator reads it; a GROUP's children sit on the requested side, else the default
 * (§23 Q16) — and that side needs an adult (children never get a room of their own: 422 `CHILDREN_NEED_AN_ADULT`).
 */
export function headcountOf(input: StaySearchInput, settings: Pick<BookingSettingRow, 'childDefaultSide'>): StayHeadcount {
  const childSide = input.bookingType === 'GROUP' ? (input.childSide ?? settings.childDefaultSide as ChildSide) : null
  const adultsWithChildren = childSide === 'FATHER' ? input.maleCount : input.femaleCount
  if (input.childCount > 0 && adultsWithChildren === 0) {
    throw new ValidationError('CHILDREN_NEED_AN_ADULT', `Children sleep on the ${childSide === 'FATHER' ? 'men' : 'women'}'s side, which has no adult`)
  }
  return { bookingType: input.bookingType, maleCount: input.maleCount, femaleCount: input.femaleCount, childCount: input.childCount, totalCount: input.totalCount, childSide }
}

/** A room type's price for the whole stay per unit (a person or a room), or null when some night has none. */
function stayPriceOfType(roomTypeId: string, nights: readonly IsoDate[], pricing: StayPricing): number | null {
  let total = 0
  for (const night of nights) {
    const price = unitPriceFor({ night, roomTypeId, unit: pricing.quote?.unit ?? pricing.unit, rates: pricing.rates, quote: pricing.quote, agencyDefault: pricing.agencyDefault })
    if (!price) return null
    total += price.amountHalalas
  }
  return total
}

/**
 * Loads what planning (or the hold re-check) needs for one hotel and stay: the rooms (on active floors, in
 * inventory) with their inventory, live claims and seat counts over the stay, the extra-bed policies, room-mix
 * rules and rates. `roomIds` restricts it to the locked rooms of a hold; the calendar options are read here too,
 * so a hold that calls this after its room locks sees any committed setting change (D-P2-22).
 */
export async function loadStayFacts(args: {
  db: Db
  hotelScope: HotelScope
  booker: Booker
  input: StaySearchInput
  headcount: StayHeadcount
  settings: Pick<BookingSettingRow, 'individualMaxRooms'>
  quote: QuoteTerms | null
  roomIds?: readonly string[]
  /** The owner whose rooms are "own" (default: the agency's, for an agency); pilgrims added to a booking pass its own. */
  ownerKey?: string | null
}): Promise<StayFacts> {
  const stay = { checkIn: args.input.checkIn, checkOut: args.input.checkOut }
  const nights = stayNights(stay)
  const repos = bookingRepos(args.db, args.hotelScope)
  const hotelScoped = hotelRepos(args.db, args.hotelScope)
  const roomIds = args.roomIds ?? null
  const [roomInputs, floors, claims, seats, policies, mixRows, rateRows, options] = await Promise.all([
    hotelScoped.inventoryRead.loadRoomInputs(nights, { roomIds: args.roomIds, includeBlocks: true }),
    hotelScoped.floors.list(),
    repos.inventory.liveClaims(roomIds, nights.from, nights.to),
    repos.inventory.seatsUsed(roomIds, nights),
    repos.extraBedPolicies.list(),
    repos.allocationRules.list(),
    repos.rates.list(),
    calendarOptionsFor(hotelScoped),
  ])

  const levels = new Map(floors.map(f => [f.id, f.level]))
  const rooms = describeStayRooms({
    rooms: roomInputs.filter(r => levels.has(r.floorId)).map(r => ({ id: r.roomId, roomNumber: r.roomNumber, roomTypeId: r.roomTypeId, floorLevel: levels.get(r.floorId)!, calendar: r })),
    stay,
    claims,
    seats,
    extraBedRules: policies,
    options,
  })
  const pricing: StayPricing = {
    unit: defaultUnitFor(args.input.bookingType),
    rates: rateRows.map(toRateRule),
    quote: args.quote,
    agencyDefault: args.booker.kind === 'AGENCY',
    extraBedPrices: policies.map(p => ({ roomTypeId: p.roomTypeId, amountHalalas: p.amountHalalas, vatIncluded: p.vatIncluded })),
  }
  const nightList = eachDate(nights)
  const typePrices = new Map([...new Set(rooms.map(r => r.roomTypeId))].map(type => [type, stayPriceOfType(type, nightList, pricing)]))
  const perPerson = (args.quote?.unit ?? pricing.unit) === 'PER_PERSON_NIGHT'
  const priced: PlannerRoom[] = rooms.flatMap((room) => {
    const price = typePrices.get(room.roomTypeId)
    return price === null || price === undefined ? [] : [{ ...room, price: perPerson ? price * room.capacity : price }]
  })

  const ownerKey = args.ownerKey !== undefined ? args.ownerKey : args.booker.kind === 'AGENCY' ? agencyOwnerKey(args.booker.agencyId) : null
  const byId = new Map(rooms.map(r => [r.id, r]))
  const planner: PlannerInput = {
    stay,
    headcount: args.headcount,
    rooms: priced,
    ownerKey,
    // Pilgrims added to a booking pass its owner: its own rooms come first whatever its type.
    ownRoomsAnyType: args.ownerKey !== undefined,
    mixRules: mixRows.map((r): MixRule => ({ groupMin: r.groupMin, groupMax: r.groupMax, minSeats: r.minSeats, maxRooms: r.maxRooms })),
    extraBedLimits: new Map(policies.map(p => [p.roomTypeId, p.maxPerBooking])),
    maxRooms: args.booker.kind === 'INDIVIDUAL' ? args.settings.individualMaxRooms : null,
    anchorLevels: ownerKey ? [...new Set(claims.filter(c => c.ownerKey === ownerKey).map(c => byId.get(c.roomId)?.floorLevel).filter((l): l is number => l !== undefined))] : [],
  }
  return { planner, pricing, rooms: byId }
}
