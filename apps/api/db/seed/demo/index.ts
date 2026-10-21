import type { DbOrTx } from '../../client'
import { hotelRepos, tenantRepos } from '../../../server/repositories'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import { DEMO_PERSONAS } from '../../../server/demo/personas'
import { DEMO_HOTELS } from '../../../server/demo/catalog'
import { normalizeEmail } from '../../../shared/utils/email'
import type { IsoDate } from '../../../shared/utils/dates'
import { demoIds } from './ids'
import { buildDemoPlan, type DemoPlan, type HotelPlan } from './inventory'

/** Repository bulk writes are chunked so one statement never carries more than this many rows. */
export const SEED_CHUNK_SIZE = 500

export function chunked<T>(items: readonly T[], size = SEED_CHUNK_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export interface DemoSeedSummary {
  anchorDate: IsoDate
  hotels: number
  floors: number
  rooms: number
  roomTypes: number
  baseVersions: number
  periods: number
  overrides: number
  blocks: number
  users: number
  hotelAccessRows: number
}

async function writeHotel(tx: DbOrTx, scope: OrganizationScope, plan: HotelPlan): Promise<void> {
  const tenant = tenantRepos(tx, scope)
  await tenant.hotels.insert(plan.hotel)
  const hotelScope = trustedHotelScope(scope, plan.hotel.id)
  const repos = hotelRepos(tx, hotelScope)

  for (const chunk of chunked(plan.floors)) await repos.floors.insertMany(chunk)
  for (const chunk of chunked(plan.rooms.map(r => r.row))) await repos.rooms.insertMany(chunk)
  for (const chunk of chunked(plan.versions)) await repos.roomBaseConfigs.insertMany(chunk)
  // Periods first (overrides reference them, and their dates through the composite FK).
  for (const period of plan.periods) await repos.capacityPeriods.insert(period)
  for (const chunk of chunked(plan.overrides)) await repos.roomCapacityOverrides.insertMany(chunk)
}

async function writeBlocks(tx: DbOrTx, scope: OrganizationScope, plan: HotelPlan): Promise<void> {
  const repos = hotelRepos(tx, trustedHotelScope(scope, plan.hotel.id))
  const actor = demoIds.user(plan.actorPersonaKey)
  for (const chunk of chunked(plan.blocks.map(b => b.row))) await repos.operationalBlocks.insertMany(chunk)
  // Cancelled and ended-early rows are written like the application writes them: insert, then the
  // repository transition (which sets the S11 columns together, so every check constraint holds).
  for (const block of plan.blocks) {
    if (block.lifecycle.kind === 'CANCELLED') {
      const updated = await repos.operationalBlocks.markCancelled(block.row.id, block.lifecycle.at, actor, block.lifecycle.reason)
      if (!updated) throw new Error(`Demo seed: block ${block.row.id} could not be cancelled`)
    }
    else if (block.lifecycle.kind === 'ENDED_EARLY') {
      const updated = await repos.operationalBlocks.endEarly(block.row.id, { newEndDate: block.lifecycle.newEndDate, at: block.lifecycle.at, by: actor, reason: block.lifecycle.reason })
      if (!updated) throw new Error(`Demo seed: block ${block.row.id} could not be ended early`)
    }
  }
}

/**
 * Writes the whole demo dataset (users with hotel access, room types, hotels with floors, rooms,
 * versioned base capacity, periods, overrides, and blocks) into an already-created demo organization,
 * through scoped repositories only. The caller owns the transaction. `passwordHash` is computed ONCE by
 * the caller and reused for all nine personas.
 */
export async function seedDemoDataset(
  tx: DbOrTx,
  scope: OrganizationScope,
  input: { anchorDate: IsoDate, passwordHash: string, roleIdByKey: Readonly<Record<string, string>> },
): Promise<DemoSeedSummary> {
  const plan: DemoPlan = buildDemoPlan(input.anchorDate)
  const tenant = tenantRepos(tx, scope)
  const adminId = demoIds.user('admin')

  // Users and their roles first (blocks and overrides name them as actors).
  const userIdByKey = new Map<string, string>()
  for (const persona of DEMO_PERSONAS) {
    const id = demoIds.user(persona.key)
    await tenant.users.insert({ id, email: normalizeEmail(persona.email), passwordHash: input.passwordHash, fullName: persona.fullName, allHotels: persona.hotelCodes === 'all' })
    const roleId = input.roleIdByKey[persona.roleKey]
    if (!roleId) throw new Error(`Demo seed: unknown role ${persona.roleKey}`)
    await tenant.roles.assignToUser(id, roleId)
    userIdByKey.set(persona.key, id)
  }

  for (const type of plan.roomTypes) await tenant.roomTypes.insert(type)
  for (const hotel of plan.hotels) await writeHotel(tx, scope, hotel)

  // Explicit hotel access (only for hotel-scoped personas; all-hotels personas hold the flag instead).
  let hotelAccessRows = 0
  for (const persona of DEMO_PERSONAS) {
    if (persona.hotelCodes === 'all') continue
    const hotelIds = persona.hotelCodes.map((code) => {
      if (!DEMO_HOTELS.some(h => h.code === code)) throw new Error(`Demo seed: persona ${persona.key} names unknown hotel ${code}`)
      return demoIds.hotel(code)
    })
    await tenant.userHotelAccess.replaceForUser(userIdByKey.get(persona.key)!, hotelIds, adminId)
    hotelAccessRows += hotelIds.length
  }

  for (const hotel of plan.hotels) await writeBlocks(tx, scope, hotel)

  return {
    anchorDate: plan.anchorDate,
    hotels: plan.hotels.length,
    floors: plan.hotels.reduce((n, h) => n + h.floors.length, 0),
    rooms: plan.hotels.reduce((n, h) => n + h.rooms.length, 0),
    roomTypes: plan.roomTypes.length,
    baseVersions: plan.hotels.reduce((n, h) => n + h.versions.length, 0),
    periods: plan.hotels.reduce((n, h) => n + h.periods.length, 0),
    overrides: plan.hotels.reduce((n, h) => n + h.overrides.length, 0),
    blocks: plan.hotels.reduce((n, h) => n + h.blocks.length, 0),
    users: DEMO_PERSONAS.length,
    hotelAccessRows,
  }
}
