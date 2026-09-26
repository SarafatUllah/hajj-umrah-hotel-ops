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

  async insert(values: NewUser): Promise<UserRow> {
    const [row] = await this.q.insert(appUser, values).returning()
    return row!
  }
}
