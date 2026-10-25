import { sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { documentSequence } from '@hajj/db/schema'
import type { DocumentSequenceKind } from '@hajj/contracts/constants/booking'
import type { OrganizationScope } from '../../security/scope'

/** Per-organization reference-number counters (quotes, bookings). */
export class DocumentSequenceRepository {
  constructor(private readonly db: DbOrTx, private readonly scope: OrganizationScope) {}

  /** The next value for (kind, year), atomically; the row stays locked until the caller's transaction ends. */
  async next(kind: DocumentSequenceKind, year: number): Promise<number> {
    const [row] = await this.db.insert(documentSequence)
      .values({ organizationId: this.scope.organizationId, kind, year, lastValue: 1 })
      .onConflictDoUpdate({ target: [documentSequence.organizationId, documentSequence.kind, documentSequence.year], set: { lastValue: sql`${documentSequence.lastValue} + 1` } })
      .returning({ value: documentSequence.lastValue })
    return row!.value
  }
}
