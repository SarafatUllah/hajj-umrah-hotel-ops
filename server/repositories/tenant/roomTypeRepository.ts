import { asc, eq } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { roomType } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type RoomTypeRow = typeof roomType.$inferSelect
export type NewRoomType = Omit<typeof roomType.$inferInsert, 'organizationId'>
/** `id`/`organizationId` are never client-settable via a patch. */
export type RoomTypePatch = Partial<Omit<typeof roomType.$inferInsert, 'id' | 'organizationId'>>

/** Organization-wide catalog (not hotel-scoped) — every statement is confined to `scope.organizationId`. */
export class RoomTypeRepository {
  private readonly q: OrgQuery

  constructor(db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async insert(values: NewRoomType): Promise<RoomTypeRow> {
    const [row] = await this.q.insert(roomType, values).returning()
    return row!
  }

  async findById(id: string): Promise<RoomTypeRow | null> {
    const [row] = await this.q.select(roomType, eq(roomType.id, id), { limit: 1 })
    return row ?? null
  }

  async findByCode(code: string): Promise<RoomTypeRow | null> {
    const [row] = await this.q.select(roomType, eq(roomType.code, code), { limit: 1 })
    return row ?? null
  }

  async list(options: { includeInactive?: boolean } = {}): Promise<RoomTypeRow[]> {
    const where = options.includeInactive ? undefined : eq(roomType.isActive, true)
    return this.q.select(roomType, where, { orderBy: [asc(roomType.sortOrder), asc(roomType.name)] })
  }

  async update(id: string, patch: RoomTypePatch): Promise<void> {
    await this.q.update(roomType, patch, eq(roomType.id, id))
  }

  async setActive(id: string, isActive: boolean): Promise<void> {
    await this.q.update(roomType, { isActive }, eq(roomType.id, id))
  }
}
