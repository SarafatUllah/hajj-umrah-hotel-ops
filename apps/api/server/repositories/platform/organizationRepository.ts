import { eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { organization } from '../../../db/schema'

/** Arbitrary constant, unique to this application's demo seed lock. */
const DEMO_SEED_LOCK_KEY = 5_120_260_901

export type OrganizationRow = typeof organization.$inferSelect
export type NewOrganization = typeof organization.$inferInsert

/**
 * Platform family (unscoped by design): the organization row is the tenant root, so it is found
 * before any scope exists (tenant resolution by slug, demo reset). Membership of this family is
 * an explicit allow-list checked by tests/unit/architecture/layering.test.ts.
 */
export class PlatformOrganizationRepository {
  constructor(private readonly db: DbOrTx) {}

  async findBySlug(slug: string): Promise<OrganizationRow | null> {
    const [row] = await this.db.select().from(organization).where(eq(organization.slug, slug)).limit(1)
    return row ?? null
  }

  async findById(id: string): Promise<OrganizationRow | null> {
    const [row] = await this.db.select().from(organization).where(eq(organization.id, id)).limit(1)
    return row ?? null
  }

  async insert(values: NewOrganization): Promise<OrganizationRow> {
    const [row] = await this.db.insert(organization).values(values).returning()
    return row!
  }

  /**
   * Demo seed / reset only: takes a transaction-scoped advisory lock that serializes every demo seed and
   * demo reset (the lock is released at COMMIT/ROLLBACK). Must be called inside a transaction. Two
   * concurrent resets therefore run one after the other instead of racing on the delete + recreate of the
   * same deterministic ids.
   */
  async lockDemoSeed(): Promise<void> {
    await this.db.execute(sql`select pg_advisory_xact_lock(${DEMO_SEED_LOCK_KEY}::bigint)`)
  }

  /**
   * Demo reset only. One statement on the organization row cascades to every table that
   * references it and is scoped strictly to this id — no other tenant's rows are reachable.
   */
  async deleteCascade(id: string): Promise<void> {
    await this.db.delete(organization).where(eq(organization.id, id))
  }
}
