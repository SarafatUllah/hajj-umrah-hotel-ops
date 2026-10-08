import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { appUser } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type UserRow = typeof appUser.$inferSelect
export type NewUser = Omit<typeof appUser.$inferInsert, 'organizationId'>

export class UserRepository {
  private readonly q: OrgQuery

  constructor(db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  /** Login lookup. The email must already be normalized (shared/utils/email). */
  async findActiveByEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.q.select(appUser, and(eq(appUser.email, email), eq(appUser.isActive, true)), { limit: 1 })
    return row ?? null
  }

  /** Any user with this email in the organization, active or not (the seed adopts an existing demo admin). */
  async findByEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.q.select(appUser, eq(appUser.email, email), { limit: 1 })
    return row ?? null
  }

  async findById(id: string): Promise<UserRow | null> {
    const [row] = await this.q.select(appUser, eq(appUser.id, id), { limit: 1 })
    return row ?? null
  }

  /**
   * Same lookup as `findById`, but row-locking (`SELECT ... FOR UPDATE`) — for callers that read a
   * user's mutable state (e.g. `allHotels`) and then write based on it in the same transaction, so a
   * concurrent writer targeting the same row serializes behind this one instead of racing it on a
   * stale read. Only valid inside a transaction: construct this repository with a `tx` handle, never
   * a bare `Database` handle, when calling this method.
   */
  async findByIdForUpdate(id: string): Promise<UserRow | null> {
    const [row] = await this.q.select(appUser, eq(appUser.id, id), { limit: 1, forUpdate: true })
    return row ?? null
  }

  async insert(values: NewUser): Promise<UserRow> {
    const [row] = await this.q.insert(appUser, values).returning()
    return row!
  }

  async setAllHotels(userId: string, value: boolean): Promise<void> {
    await this.q.update(appUser, { allHotels: value }, eq(appUser.id, userId))
  }
}
