import { and, count, desc, eq, inArray, lte, type SQL } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { priceQuote } from '@hajj/db/schema'
import type { QuoteStatus } from '@hajj/contracts/constants/pricing'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type PriceQuoteRow = typeof priceQuote.$inferSelect
export type NewPriceQuote = Omit<typeof priceQuote.$inferInsert, 'organizationId'>

export interface QuoteListFilter {
  status?: QuoteStatus
  hotelId?: string
  agencyId?: string
  /** Staff without access to every hotel see only these hotels' quotes. */
  hotelIds?: readonly string[]
  page: number
  pageSize: number
}

export interface QuoteOffer { amountHalalas: number, unit: string, vatIncluded: boolean, validUntil: Date, offeredBy: string, offeredAt: Date }

/** WhatsApp price quotes of one organization (v7 §8). Agency-facing reads always pass the caller's agency id. */
export class PriceQuoteRepository {
  private readonly q: OrgQuery

  constructor(private readonly db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async insert(values: NewPriceQuote): Promise<PriceQuoteRow> {
    const [row] = await this.q.insert(priceQuote, values).returning()
    return row!
  }

  /** `forUpdate` (inside a transaction) row-locks the quote: offers, declines and its use by a booking serialize. */
  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<PriceQuoteRow | null> {
    const [row] = await this.q.select(priceQuote, eq(priceQuote.id, id), { limit: 1, forUpdate: options.forUpdate })
    return row ?? null
  }

  /** Newest first. */
  async list(filter: QuoteListFilter): Promise<{ rows: PriceQuoteRow[], total: number }> {
    const conditions: Array<SQL | undefined> = [
      filter.status ? eq(priceQuote.status, filter.status) : undefined,
      filter.hotelId ? eq(priceQuote.hotelId, filter.hotelId) : undefined,
      filter.agencyId ? eq(priceQuote.agencyId, filter.agencyId) : undefined,
      filter.hotelIds ? inArray(priceQuote.hotelId, filter.hotelIds.length > 0 ? [...filter.hotelIds] : ['00000000-0000-0000-0000-000000000000']) : undefined,
    ]
    const where = this.q.cond(priceQuote, ...conditions)
    const [rows, [totalRow]] = await Promise.all([
      this.db.select().from(priceQuote).where(where).orderBy(desc(priceQuote.createdAt), desc(priceQuote.id)).limit(filter.pageSize).offset((filter.page - 1) * filter.pageSize),
      this.db.select({ value: count() }).from(priceQuote).where(where),
    ])
    return { rows, total: Number(totalRow?.value ?? 0) }
  }

  async setOffer(id: string, offer: QuoteOffer): Promise<PriceQuoteRow | null> {
    const [row] = await this.q.update(priceQuote, { status: 'OFFERED', ...offer, updatedAt: offer.offeredAt }, eq(priceQuote.id, id)).returning()
    return row ?? null
  }

  async setStatus(id: string, status: QuoteStatus, at: Date): Promise<PriceQuoteRow | null> {
    const [row] = await this.q.update(priceQuote, { status, updatedAt: at }, eq(priceQuote.id, id)).returning()
    return row ?? null
  }

  /** The hourly sweep: OFFERED quotes past their validity become EXPIRED; returns how many. */
  async expireOffered(now: Date): Promise<number> {
    const rows = await this.q.update(priceQuote, { status: 'EXPIRED', updatedAt: now }, and(eq(priceQuote.status, 'OFFERED'), lte(priceQuote.validUntil, now))).returning({ id: priceQuote.id })
    return rows.length
  }
}
