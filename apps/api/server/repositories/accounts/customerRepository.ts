import { eq, isNull, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { customer } from '@hajj/db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type CustomerRow = typeof customer.$inferSelect
export type NewCustomer = Omit<typeof customer.$inferInsert, 'organizationId'>

/** The name a closed account keeps (the column is required; the person's name is gone). */
export const CLOSED_ACCOUNT_NAME = 'Closed account'

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

  /**
   * Step 15b account closure: the row stays (bookings name it) without phone, name or e-mail, inactive, every session
   * ended; the phone may sign up again as a new account. null = no open account with this id (already closed).
   */
  async close(id: string, at: Date): Promise<CustomerRow | null> {
    const [row] = await this.q.update(
      customer,
      { phone: null, phoneVerifiedAt: null, fullName: CLOSED_ACCOUNT_NAME, email: null, lastLoginAt: null, isActive: false, closedAt: at, sessionVersion: sql`${customer.sessionVersion} + 1`, updatedAt: at },
      eq(customer.id, id),
      isNull(customer.closedAt),
    ).returning()
    return row ?? null
  }

  /** A sign-in's time (never on a closed account: a sign-in racing the closure leaves no trace on it). */
  async recordLogin(id: string, at: Date): Promise<void> {
    await this.q.update(customer, { lastLoginAt: at }, eq(customer.id, id), isNull(customer.closedAt))
  }
}
