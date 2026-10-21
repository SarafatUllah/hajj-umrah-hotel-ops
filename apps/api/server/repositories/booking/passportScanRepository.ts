import { and, asc, count, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { documentAsset, passportScan } from '@hajj/db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type PassportScanRow = typeof passportScan.$inferSelect
type NewPassportScan = Omit<typeof passportScan.$inferInsert, 'organizationId' | 'id' | 'createdAt' | 'updatedAt'>

/** What a reading left on the scan (status NEEDS_REVIEW or FAILED). */
export interface ScanReading {
  status: 'NEEDS_REVIEW' | 'FAILED'
  method: string | null
  extractedEncrypted: string | null
  confidence: Record<string, number> | null
  failureReason: string | null
  bookingGuestId: string | null
}

export interface ScanReview { reviewedByKind: string, reviewedById: string | null, reviewedAt: Date }

/** Scans still on their way to a slot (queued, being read, or waiting for review). */
const OPEN = ['QUEUED', 'PROCESSING', 'NEEDS_REVIEW']
/** Scans nobody has resolved yet (a FAILED one can still be confirmed by hand). */
const UNRESOLVED = [...OPEN, 'FAILED']
/** A reading unfinished after this long is taken as crashed (the worker died): the job's retry may read it again. */
const STALE_READING_MS = 10 * 60 * 1000

/** A PROCESSING scan whose reading has not finished by `at` minus the stale window: its worker is taken as dead. */
const staleReading = (at: Date) => and(eq(passportScan.status, 'PROCESSING'), lt(passportScan.updatedAt, new Date(at.getTime() - STALE_READING_MS)))

/** An image whose retention ended, still stored. */
export interface ScanImageDue { scanId: string, documentId: string, storageKey: string }

/** Passport scans of one organization (v7 §13, ticket 1): each belongs to a booking and, once confirmed, to the booker's copy it filled. */
export class PassportScanRepository {
  readonly #q: OrgQuery

  constructor(private readonly db: DbOrTx, scope: OrganizationScope) {
    this.#q = new OrgQuery(db, scope)
  }

  async insert(values: NewPassportScan): Promise<PassportScanRow> {
    const [row] = await this.#q.insert(passportScan, values).returning()
    return row!
  }

  /** `forUpdate` (inside a transaction) row-locks the scan: a reading and a review never interleave. */
  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<PassportScanRow | null> {
    const [row] = await this.#q.select(passportScan, eq(passportScan.id, id), { limit: 1, forUpdate: options.forUpdate })
    return row ?? null
  }

  async listForBooking(bookingId: string): Promise<PassportScanRow[]> {
    return this.#q.select(passportScan, eq(passportScan.bookingId, bookingId), { orderBy: [asc(passportScan.createdAt), asc(passportScan.id)] })
  }

  /**
   * QUEUED → PROCESSING, or a stale PROCESSING taken over; null when the scan is not waiting to be read (another
   * worker is reading it, or it was read or discarded).
   */
  async startReading(id: string, at: Date): Promise<PassportScanRow | null> {
    const [row] = await this.#q.update(passportScan, { status: 'PROCESSING', updatedAt: at }, eq(passportScan.id, id), or(eq(passportScan.status, 'QUEUED'), staleReading(at))).returning()
    return row ?? null
  }

  /** PROCESSING → the reading's result; null when the scan is no longer being read. */
  async recordReading(id: string, reading: ScanReading, at: Date): Promise<PassportScanRow | null> {
    const [row] = await this.#q.update(passportScan, { ...reading, updatedAt: at }, eq(passportScan.id, id), eq(passportScan.status, 'PROCESSING')).returning()
    return row ?? null
  }

  /** A person confirmed the review form: the scan points at the slot and the booker's copy it filled. */
  async confirm(id: string, target: { bookingGuestId: string, bookingGuestDetailId: string }, review: ScanReview): Promise<PassportScanRow | null> {
    const [row] = await this.#q.update(passportScan, { status: 'CONFIRMED', ...target, ...review, updatedAt: review.reviewedAt }, eq(passportScan.id, id), inArray(passportScan.status, ['NEEDS_REVIEW', 'FAILED'])).returning()
    return row ?? null
  }

  /** Thrown away (a reading that died long ago too): the image is due for deletion at once (`deleteAfter`, normally today). */
  async discard(id: string, review: ScanReview, deleteAfter: string): Promise<PassportScanRow | null> {
    const discardable = or(inArray(passportScan.status, ['QUEUED', 'NEEDS_REVIEW', 'FAILED']), staleReading(review.reviewedAt))
    const [row] = await this.#q.update(passportScan, { status: 'DISCARDED', deleteAfter, ...review, updatedAt: review.reviewedAt }, eq(passportScan.id, id), discardable).returning()
    return row ?? null
  }

  /** The image is deleted: the reading taken from it goes too (the record stays, without personal data). */
  async clearReading(id: string, at: Date): Promise<PassportScanRow | null> {
    const [row] = await this.#q.update(passportScan, { extractedEncrypted: null, updatedAt: at }, eq(passportScan.id, id)).returning()
    return row ?? null
  }

  /**
   * Ticket 4: the scans of these bookings lose their reading now, and their images become due by `today` at the
   * latest (the image sweep deletes them), whatever the image retention says.
   */
  async expireForBookings(bookingIds: readonly string[], today: string, at: Date): Promise<number> {
    if (bookingIds.length === 0) return 0
    const rows = await this.#q.update(
      passportScan,
      { extractedEncrypted: null, deleteAfter: sql`least(coalesce(${passportScan.deleteAfter}, ${today}::date), ${today}::date)`, updatedAt: at },
      inArray(passportScan.bookingId, [...bookingIds]),
    ).returning({ id: passportScan.id })
    return rows.length
  }

  /** The booking's dates changed: its images (a discarded one keeps its own, earlier date) are kept until `deleteAfter`. Returns how many scans changed. */
  async retainUntil(bookingId: string, deleteAfter: string, at: Date): Promise<number> {
    const rows = await this.#q.update(passportScan, { deleteAfter, updatedAt: at }, eq(passportScan.bookingId, bookingId), ne(passportScan.status, 'DISCARDED')).returning({ id: passportScan.id })
    return rows.length
  }

  async countUnresolved(bookingId: string): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(passportScan)
      .where(this.#q.cond(passportScan, eq(passportScan.bookingId, bookingId), inArray(passportScan.status, UNRESOLVED)))
    return row?.n ?? 0
  }

  /**
   * Images due for deletion (`delete_after` on or before `today`) and still stored, the most overdue first. A scan
   * being read is skipped until its reading ends (or dies), so no reading is stored after its image is gone.
   */
  async imagesDue(today: string, now: Date, limit: number): Promise<ScanImageDue[]> {
    // A cancelled or lapsed booking's scans were made due when it ended (`delete_after` today): the date index drives this.
    return this.db.select({ scanId: passportScan.id, documentId: passportScan.documentId, storageKey: documentAsset.storageKey })
      .from(passportScan)
      .innerJoin(documentAsset, and(eq(documentAsset.organizationId, passportScan.organizationId), eq(documentAsset.id, passportScan.documentId)))
      .where(this.#q.cond(passportScan, lte(passportScan.deleteAfter, today), isNull(documentAsset.archivedAt), or(ne(passportScan.status, 'PROCESSING'), staleReading(now))))
      .orderBy(asc(passportScan.deleteAfter), asc(passportScan.id))
      .limit(limit)
  }

  /** The slots open scans of the booking already point at (a new scan is placed elsewhere). */
  async targetedSlots(bookingId: string): Promise<string[]> {
    const rows = await this.db.select({ guestId: passportScan.bookingGuestId }).from(passportScan)
      .where(this.#q.cond(passportScan, eq(passportScan.bookingId, bookingId), inArray(passportScan.status, OPEN), isNotNull(passportScan.bookingGuestId)))
    return rows.flatMap(r => (r.guestId ? [r.guestId] : []))
  }
}
