import { asc, eq } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { agencyQuota, allocationRule, extraBedPolicy, rate } from '@hajj/db/schema'
import type { HotelScope } from '../../security/scope'
import { HotelQuery } from '../base/scopedQuery'

type RuleTable = typeof rate | typeof agencyQuota | typeof allocationRule | typeof extraBedPolicy

/**
 * The hotel-level booking rules (v7 §15) share one shape — hotel-scoped rows a manager lists, adds, edits and
 * removes — so one implementation serves them all (the concrete `*Repository` classes below; this base is
 * deliberately not named a repository, so the isolation registry covers each concrete table's methods);
 * overlap and uniqueness are enforced by each table's constraints. Every statement carries the organization AND
 * hotel predicate.
 */
export class ScopedRuleTable<T extends RuleTable> {
  protected readonly q: HotelQuery

  constructor(protected readonly db: DbOrTx, scope: HotelScope, private readonly table: T) {
    this.q = new HotelQuery(db, scope)
  }

  /** Oldest first (stable listing). */
  async list(): Promise<Array<T['$inferSelect']>> {
    return this.q.select(this.table, undefined, { orderBy: [asc(this.table.createdAt), asc(this.table.id)] })
  }

  /** `forUpdate` (inside a transaction only) row-locks the rule, so concurrent edits of it serialize. */
  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<T['$inferSelect'] | null> {
    const [row] = await this.q.select(this.table, eq(this.table.id, id), { limit: 1, forUpdate: options.forUpdate })
    return row ?? null
  }

  async insert(values: Omit<T['$inferInsert'], 'organizationId' | 'hotelId'>): Promise<T['$inferSelect']> {
    const [row] = await this.q.insert(this.table, values).returning()
    return row as T['$inferSelect']
  }

  async update(id: string, values: Partial<Omit<T['$inferInsert'], 'organizationId' | 'hotelId' | 'id'>>): Promise<T['$inferSelect'] | null> {
    // `T` is a union of tables, so its update shape is too wide for TypeScript to relate to `values` here.
    const set = { ...values, updatedAt: new Date() } as Parameters<HotelQuery['update']>[1]
    const [row] = await this.q.update(this.table, set, eq(this.table.id, id)).returning()
    return (row as T['$inferSelect'] | undefined) ?? null
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.q.delete(this.table, eq(this.table.id, id)).returning({ id: this.table.id })
    return rows.length > 0
  }
}

export class RateRepository extends ScopedRuleTable<typeof rate> {
  constructor(db: DbOrTx, scope: HotelScope) { super(db, scope, rate) }
}

export class AgencyQuotaRepository extends ScopedRuleTable<typeof agencyQuota> {
  constructor(db: DbOrTx, scope: HotelScope) { super(db, scope, agencyQuota) }
}

export class AllocationRuleRepository extends ScopedRuleTable<typeof allocationRule> {
  constructor(db: DbOrTx, scope: HotelScope) { super(db, scope, allocationRule) }
}

export class ExtraBedPolicyRepository extends ScopedRuleTable<typeof extraBedPolicy> {
  constructor(db: DbOrTx, scope: HotelScope) { super(db, scope, extraBedPolicy) }
}

/** What the booking-rules service needs from any rule table: plain rows in, plain rows out. */
export interface RuleStore {
  list(): Promise<Array<Record<string, unknown> & { id: string }>>
  findById(id: string, options?: { forUpdate?: boolean }): Promise<(Record<string, unknown> & { id: string }) | null>
  insert(values: Record<string, unknown>): Promise<Record<string, unknown> & { id: string }>
  update(id: string, values: Record<string, unknown>): Promise<(Record<string, unknown> & { id: string }) | null>
  delete(id: string): Promise<boolean>
}
