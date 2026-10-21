import { lt } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { eventReceipt } from '@hajj/db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

/** The domain-event handlers that already ran in one organization (ticket 7). */
export class EventReceiptRepository {
  readonly #q: OrgQuery

  constructor(db: DbOrTx, scope: OrganizationScope) {
    this.#q = new OrgQuery(db, scope)
  }

  /**
   * Claims the run of `handler` for `eventId`: true for the first claim, false when it already ran. Inside the
   * handler's transaction, so a handler that fails gives its claim back.
   */
  async claim(eventId: string, handler: string): Promise<boolean> {
    const rows = await this.#q.insert(eventReceipt, { eventId, handler }).onConflictDoNothing().returning({ eventId: eventReceipt.eventId })
    return rows.length > 0
  }

  /** Removes the receipts of events handled before `before`; returns how many. */
  async deleteProcessedBefore(before: Date): Promise<number> {
    const rows = await this.#q.delete(eventReceipt, lt(eventReceipt.processedAt, before)).returning({ eventId: eventReceipt.eventId })
    return rows.length
  }
}
