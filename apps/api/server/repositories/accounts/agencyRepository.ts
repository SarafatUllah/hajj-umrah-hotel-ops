import { asc, count, eq, ilike, or, type SQL } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { agency } from '@hajj/db/schema'
import type { AgencyStatus } from '@hajj/contracts/constants/accounts'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type AgencyRow = typeof agency.$inferSelect
export type NewAgency = Omit<typeof agency.$inferInsert, 'organizationId'>

export interface AgencyListFilter { status?: AgencyStatus, q?: string, page: number, pageSize: number }
export interface AgencyPage { rows: AgencyRow[], total: number }

/** `%`, `_` and `\` are literal in a user's search text. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`

/** Agencies of one organization (v7 §16: agencies live inside the operator's organization). */
export class AgencyRepository {
  private readonly q: OrgQuery

  constructor(private readonly db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async insert(values: NewAgency): Promise<AgencyRow> {
    const [row] = await this.q.insert(agency, values).returning()
    return row!
  }

  /** `forUpdate` (inside a transaction only) row-locks the agency, serializing status changes. */
  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<AgencyRow | null> {
    const [row] = await this.q.select(agency, eq(agency.id, id), { limit: 1, forUpdate: options.forUpdate })
    return row ?? null
  }

  /** Exact match on the normalized licence number. */
  async findByLicenseNo(licenseNo: string): Promise<AgencyRow | null> {
    const [row] = await this.q.select(agency, eq(agency.licenseNo, licenseNo), { limit: 1 })
    return row ?? null
  }

  /** Alphabetical; `q` matches name, licence number or e-mail. */
  async list(filter: AgencyListFilter): Promise<AgencyPage> {
    const search: SQL | undefined = filter.q ? or(ilike(agency.name, likePattern(filter.q)), ilike(agency.licenseNo, likePattern(filter.q)), ilike(agency.email, likePattern(filter.q))) : undefined
    const where = this.q.cond(agency, filter.status ? eq(agency.status, filter.status) : undefined, search)
    const [rows, [totalRow]] = await Promise.all([
      this.db.select().from(agency).where(where).orderBy(asc(agency.name), asc(agency.id)).limit(filter.pageSize).offset((filter.page - 1) * filter.pageSize),
      this.db.select({ value: count() }).from(agency).where(where),
    ])
    return { rows, total: Number(totalRow?.value ?? 0) }
  }

  /** Records a status decision; `approvedAt`/`approvedBy` are set on approval and kept otherwise. */
  async setStatus(id: string, change: { status: AgencyStatus, reason: string, at: Date, by: string }): Promise<AgencyRow | null> {
    const approval = change.status === 'APPROVED' ? { approvedAt: change.at, approvedBy: change.by } : {}
    const [row] = await this.q.update(agency, { status: change.status, statusReason: change.reason, updatedAt: change.at, ...approval }, eq(agency.id, id)).returning()
    return row ?? null
  }
}
