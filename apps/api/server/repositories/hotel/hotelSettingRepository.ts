import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { hotelSetting } from '../../../db/schema'
import type { HotelScope } from '../../security/scope'
import { HotelQuery } from '../base/scopedQuery'

export type HotelSettingRow = typeof hotelSetting.$inferSelect

export class HotelSettingRepository {
  private readonly q: HotelQuery

  constructor(db: DbOrTx, scope: HotelScope) {
    this.q = new HotelQuery(db, scope)
  }

  async getAll(): Promise<HotelSettingRow[]> {
    return this.q.select(hotelSetting)
  }

  /**
   * Upsert keyed by (organizationId, hotelId, key) — the table's primary key. organizationId leads
   * the conflict target (not just hotelId, key) so a scope holding a leaked hotelId from another
   * organization can never match — and therefore never update — that organization's existing row;
   * it falls through to an INSERT, which the composite FK then rejects.
   */
  async upsert(key: string, value: unknown): Promise<void> {
    await this.q.insert(hotelSetting, { key, value }).onConflictDoUpdate({
      target: [hotelSetting.organizationId, hotelSetting.hotelId, hotelSetting.key],
      set: { value, updatedAt: sql`now()` },
    })
  }
}
