import { and, eq, isNull } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { documentAsset } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type DocumentAssetRow = typeof documentAsset.$inferSelect
/** `organizationId` comes from the scope; `archivedAt` is only ever written by `markArchived`. */
export type NewDocumentAsset = Omit<typeof documentAsset.$inferInsert, 'id' | 'organizationId' | 'createdAt' | 'archivedAt'>

/**
 * Stored-file metadata (Organization scope). There is deliberately NO delete method: assets are
 * archived (`markArchived`), never deleted by the application. Which HOTEL an asset belongs to is
 * `hotel_document`'s business — hotel-facing reads and the hotel check go through
 * `HotelDocumentRepository`.
 */
export class DocumentAssetRepository {
  private readonly q: OrgQuery

  constructor(db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async insert(values: NewDocumentAsset): Promise<DocumentAssetRow> {
    const [row] = await this.q.insert(documentAsset, values).returning()
    return row!
  }

  async findById(id: string): Promise<DocumentAssetRow | null> {
    const [row] = await this.q.select(documentAsset, eq(documentAsset.id, id), { limit: 1 })
    return row ?? null
  }

  /** Sets `archived_at` on a not-yet-archived asset; returns the updated row, or null when nothing matched (unknown, foreign, or already archived). */
  async markArchived(id: string, at: Date): Promise<DocumentAssetRow | null> {
    const [row] = await this.q.update(documentAsset, { archivedAt: at }, and(eq(documentAsset.id, id), isNull(documentAsset.archivedAt))).returning()
    return row ?? null
  }
}
