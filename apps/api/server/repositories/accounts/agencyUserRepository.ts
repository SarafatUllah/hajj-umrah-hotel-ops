import { and, asc, eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { agencyUser } from '@hajj/db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type AgencyUserRow = typeof agencyUser.$inferSelect
export type NewAgencyUser = Omit<typeof agencyUser.$inferInsert, 'organizationId'>

/** Agency-portal sign-ins. E-mails are unique per organization and must already be normalized. */
export class AgencyUserRepository {
  private readonly q: OrgQuery

  constructor(db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async insert(values: NewAgencyUser): Promise<AgencyUserRow> {
    const [row] = await this.q.insert(agencyUser, values).returning()
    return row!
  }

  async findById(id: string): Promise<AgencyUserRow | null> {
    const [row] = await this.q.select(agencyUser, eq(agencyUser.id, id), { limit: 1 })
    return row ?? null
  }

  /** Any user with this (normalized) e-mail, active or not. */
  async findByEmail(email: string): Promise<AgencyUserRow | null> {
    const [row] = await this.q.select(agencyUser, eq(agencyUser.email, email), { limit: 1 })
    return row ?? null
  }

  /** Login lookup (normalized e-mail). */
  async findActiveByEmail(email: string): Promise<AgencyUserRow | null> {
    const [row] = await this.q.select(agencyUser, and(eq(agencyUser.email, email), eq(agencyUser.isActive, true)), { limit: 1 })
    return row ?? null
  }

  async listByAgency(agencyId: string): Promise<AgencyUserRow[]> {
    return this.q.select(agencyUser, eq(agencyUser.agencyId, agencyId), { orderBy: [asc(agencyUser.fullName), asc(agencyUser.id)] })
  }

  /** Activates or deactivates a user of `agencyId`; deactivation also ends every session (session version). Null when no such user. */
  async setActive(id: string, agencyId: string, isActive: boolean, at: Date): Promise<AgencyUserRow | null> {
    const sessionVersion = isActive ? undefined : sql`${agencyUser.sessionVersion} + 1`
    const [row] = await this.q.update(agencyUser, { isActive, updatedAt: at, ...(sessionVersion ? { sessionVersion } : {}) }, eq(agencyUser.id, id), eq(agencyUser.agencyId, agencyId)).returning()
    return row ?? null
  }

  /** A new password: every session of the user ends (the session version moves on). */
  async setPassword(id: string, agencyId: string, passwordHash: string, at: Date): Promise<AgencyUserRow | null> {
    const [row] = await this.q.update(agencyUser, { passwordHash, sessionVersion: sql`${agencyUser.sessionVersion} + 1`, updatedAt: at }, eq(agencyUser.id, id), eq(agencyUser.agencyId, agencyId)).returning()
    return row ?? null
  }

  async recordLogin(id: string, at: Date): Promise<void> {
    await this.q.update(agencyUser, { lastLoginAt: at }, eq(agencyUser.id, id))
  }
}
