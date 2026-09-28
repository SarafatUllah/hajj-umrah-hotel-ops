import { eq, inArray } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { hotel } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type HotelRow = typeof hotel.$inferSelect
export type NewHotel = Omit<typeof hotel.$inferInsert, 'organizationId'>
/** `code` is immutable after creation (domain rule); `id`/`organizationId` are never client-settable. */
export type HotelPatch = Partial<Omit<typeof hotel.$inferInsert, 'id' | 'organizationId' | 'code'>>

export class HotelRepository {
  private readonly q: OrgQuery

  constructor(db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async insert(values: NewHotel): Promise<HotelRow> {
    const [row] = await this.q.insert(hotel, values).returning()
    return row!
  }

  async findById(id: string): Promise<HotelRow | null> {
    const [row] = await this.q.select(hotel, eq(hotel.id, id), { limit: 1 })
    return row ?? null
  }

  async findByCode(code: string): Promise<HotelRow | null> {
    const [row] = await this.q.select(hotel, eq(hotel.code, code), { limit: 1 })
    return row ?? null
  }

  async listByIds(ids: readonly string[]): Promise<HotelRow[]> {
    if (ids.length === 0) return []
    return this.q.select(hotel, inArray(hotel.id, ids as string[]))
  }

  async listAll(): Promise<HotelRow[]> {
    return this.q.select(hotel)
  }

  async update(id: string, patch: HotelPatch): Promise<void> {
    await this.q.update(hotel, patch, eq(hotel.id, id))
  }

  async setStatus(id: string, status: string): Promise<void> {
    await this.q.update(hotel, { status }, eq(hotel.id, id))
  }
}
