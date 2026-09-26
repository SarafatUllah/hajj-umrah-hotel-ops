import type { DbOrTx } from '../../../db/client'
import { auditLog } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type AuditLogRow = typeof auditLog.$inferSelect
export type NewAuditEntry = Omit<typeof auditLog.$inferInsert, 'organizationId' | 'id' | 'createdAt'>

export class AuditRepository {
  private readonly q: OrgQuery

  constructor(db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async record(entry: NewAuditEntry): Promise<void> {
    await this.q.insert(auditLog, entry)
  }
}
