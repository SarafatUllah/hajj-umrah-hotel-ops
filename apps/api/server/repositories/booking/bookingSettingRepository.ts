import { eq } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { bookingSetting } from '@hajj/db/schema'
import type { OrganizationScope } from '../../security/scope'

export type BookingSettingRow = typeof bookingSetting.$inferSelect
export type BookingSettingValues = Partial<Omit<typeof bookingSetting.$inferInsert, 'organizationId' | 'updatedAt' | 'updatedBy'>>

/**
 * The organization's booking settings row. A missing row means "all defaults": `ensure` creates it from the
 * column defaults on first use, so the defaults live in ONE place (the schema) and every reader sees a full row;
 * an existing row is read without writing.
 */
export class BookingSettingRepository {
  constructor(private readonly db: DbOrTx, private readonly scope: OrganizationScope) {}

  // True JS-private (not TypeScript `private`), so the isolation-registry coverage scan sees only public methods.
  #select(forUpdate: boolean) {
    const query = this.db.select().from(bookingSetting).where(eq(bookingSetting.organizationId, this.scope.organizationId)).limit(1)
    return forUpdate ? query.for('update') : query
  }

  async #read(forUpdate: boolean): Promise<BookingSettingRow> {
    const [existing] = await this.#select(forUpdate)
    if (existing) return existing
    await this.db.insert(bookingSetting).values({ organizationId: this.scope.organizationId }).onConflictDoNothing()
    const [created] = await this.#select(forUpdate)
    return created!
  }

  async ensure(): Promise<BookingSettingRow> {
    return this.#read(false)
  }

  /** Inside a transaction: ensures the row, then row-locks it. */
  async ensureForUpdate(): Promise<BookingSettingRow> {
    return this.#read(true)
  }

  async update(values: BookingSettingValues, by: string, at: Date): Promise<BookingSettingRow> {
    const [row] = await this.db.update(bookingSetting).set({ ...values, updatedAt: at, updatedBy: by }).where(eq(bookingSetting.organizationId, this.scope.organizationId)).returning()
    return row!
  }
}
