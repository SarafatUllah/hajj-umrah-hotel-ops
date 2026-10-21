import { eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { customer } from '@hajj/db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type CustomerRow = typeof customer.$inferSelect
export type NewCustomer = Omit<typeof customer.$inferInsert, 'organizationId'>

/** Individual bookers of one organization, identified by a verified E.164 phone. */
export class CustomerRepository {
  private readonly q: OrgQuery

  constructor(db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async insert(values: NewCustomer): Promise<CustomerRow> {
    const [row] = await this.q.insert(customer, values).returning()
    return row!
  }

  async findById(id: string): Promise<CustomerRow | null> {
    const [row] = await this.q.select(customer, eq(customer.id, id), { limit: 1 })
    return row ?? null
  }

  async findByPhone(phone: string): Promise<CustomerRow | null> {
    const [row] = await this.q.select(customer, eq(customer.phone, phone), { limit: 1 })
    return row ?? null
  }

  /** "Sign out everywhere": every existing session of the customer stops resolving. */
  async bumpSessionVersion(id: string): Promise<void> {
    await this.q.update(customer, { sessionVersion: sql`${customer.sessionVersion} + 1`, updatedAt: new Date() }, eq(customer.id, id))
  }

  async recordLogin(id: string, at: Date): Promise<void> {
    await this.q.update(customer, { lastLoginAt: at }, eq(customer.id, id))
  }
}
