import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { organization } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import type { OrganizationRow } from '../platform/organizationRepository'

/**
 * Tenant-scoped view of the organization row itself (S1). Unlike every other tenant repository,
 * `organization` has no `organization_id` column of its own — it IS the tenant root, so `getOwn`
 * cannot go through `OrgQuery`. It takes no id parameter by design: it can only ever read the
 * scope's OWN organization, never another one, so a caller can never use it to probe a foreign org.
 */
export class TenantOrganizationRepository {
  constructor(private readonly db: DbOrTx, private readonly scope: OrganizationScope) {}

  /** The scope's own organization row. Every authenticated scope's organization is guaranteed to exist (FK-protected), so a missing row here is a bug, not a client-facing condition. */
  async getOwn(): Promise<OrganizationRow> {
    const [row] = await this.db.select().from(organization).where(eq(organization.id, this.scope.organizationId)).limit(1)
    if (!row) throw new Error(`Organization row missing for scope ${this.scope.organizationId}`)
    return row
  }
}
