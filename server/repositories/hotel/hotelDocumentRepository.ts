import { and, count, desc, eq, isNull, type SQL } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { documentAsset, hotelDocument } from '../../../db/schema'
import type { HotelScope } from '../../security/scope'
import { HotelQuery } from '../base/scopedQuery'
import type { DocumentAssetRow } from '../tenant/documentAssetRepository'

export type HotelDocumentRow = typeof hotelDocument.$inferSelect
/** `organizationId`/`hotelId` come from the scope; `documentId` is the (already inserted) asset's id. */
export type NewHotelDocument = Omit<typeof hotelDocument.$inferInsert, 'organizationId' | 'hotelId' | 'createdAt'>

/** A hotel document plus its stored-file metadata (one joined row). */
export interface HotelDocumentView { document: HotelDocumentRow, asset: DocumentAssetRow }

export interface DocumentListFilter { includeArchived: boolean, page: number, pageSize: number }
export interface DocumentListPage { rows: HotelDocumentView[], total: number }

/**
 * Hotel documents (Hotel scope). Every statement carries the organization AND hotel predicate of
 * `hotel_document` via `HotelQuery`, and the join to `document_asset` carries that table's own
 * organization predicate (the composite FK makes a cross-organization pairing impossible; the
 * predicate keeps the query itself honest). No delete method: documents are archived, never deleted.
 */
export class HotelDocumentRepository {
  private readonly q: HotelQuery

  constructor(private readonly db: DbOrTx, private readonly scope: HotelScope) {
    this.q = new HotelQuery(db, scope)
  }

  async insert(values: NewHotelDocument): Promise<HotelDocumentRow> {
    const [row] = await this.q.insert(hotelDocument, values).returning()
    return row!
  }

  /**
   * One document of THIS hotel with its asset, or null (nonexistent, another hotel's, another
   * organization's — indistinguishable). `forUpdate` row-locks both rows (archive read-then-write);
   * only meaningful inside a transaction.
   */
  async findView(documentId: string, options: { forUpdate?: boolean } = {}): Promise<HotelDocumentView | null> {
    const [row] = await this.#selectViews(this.q.cond(hotelDocument, eq(hotelDocument.documentId, documentId)), { limit: 1, forUpdate: options.forUpdate })
    return row ?? null
  }

  /** Newest first. Archived documents are excluded unless `includeArchived`. One statement for the page, one for the total. */
  async list(filter: DocumentListFilter): Promise<DocumentListPage> {
    const where = this.q.cond(hotelDocument, filter.includeArchived ? undefined : isNull(documentAsset.archivedAt))
    const rows = await this.#selectViews(where, { limit: filter.pageSize, offset: (filter.page - 1) * filter.pageSize })
    const [totalRow] = await this.db
      .select({ value: count() })
      .from(hotelDocument)
      .innerJoin(documentAsset, this.#assetJoin())
      .where(where)
    return { rows, total: Number(totalRow?.value ?? 0) }
  }

  /** The asset side of the join: same organization as the scope, matched on the document id. */
  #assetJoin(): SQL {
    return and(eq(documentAsset.id, hotelDocument.documentId), eq(documentAsset.organizationId, this.scope.organizationId))!
  }

  // True JS-private (not TypeScript `private`), so the isolation-registry coverage scan does not see
  // it as a public repository method. `where` must already carry the scope predicate.
  async #selectViews(where: SQL, o: { limit?: number, offset?: number, forUpdate?: boolean } = {}): Promise<HotelDocumentView[]> {
    let query = this.db
      .select({ document: hotelDocument, asset: documentAsset })
      .from(hotelDocument)
      .innerJoin(documentAsset, this.#assetJoin())
      .where(where)
      .orderBy(desc(documentAsset.createdAt), desc(hotelDocument.documentId))
      .$dynamic()
    if (o.limit !== undefined) query = query.limit(o.limit)
    if (o.offset !== undefined) query = query.offset(o.offset)
    if (o.forUpdate) query = query.for('update')
    return query
  }
}
