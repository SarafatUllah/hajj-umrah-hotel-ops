import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { role, rolePermission, userRole } from '../../../db/schema'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type RoleRow = typeof role.$inferSelect
export type NewRole = Omit<typeof role.$inferInsert, 'organizationId'>

/** A role id that does not belong to the caller's organization (treated exactly like a missing role). */
export class RoleNotInScopeError extends Error {
  constructor() {
    super('Role not found in this organization')
    this.name = 'RoleNotInScopeError'
  }
}

/*
 * Exception to "every table goes through the scoped predicate" (PF-15): role_permission links a
 * role to the GLOBAL permission catalog and has no organization_id. It is touched only
 *   - by grantPermissions, after the role has been verified to belong to this scope, and
 *   - by permissionKeysForUser, joined through user_role and role, both constrained to this scope.
 * Each of those methods has its own case in the tenant-isolation registry.
 */
export class RoleRepository {
  private readonly q: OrgQuery

  constructor(private readonly db: DbOrTx, scope: OrganizationScope) {
    this.q = new OrgQuery(db, scope)
  }

  async findByKey(key: string): Promise<RoleRow | null> {
    const [row] = await this.q.select(role, eq(role.key, key), { limit: 1 })
    return row ?? null
  }

  async insert(values: NewRole): Promise<RoleRow> {
    const [row] = await this.q.insert(role, values).returning()
    return row!
  }

  /** Idempotent. Throws RoleNotInScopeError when the role is not in this organization. */
  async grantPermissions(roleId: string, permissionKeys: readonly string[]): Promise<void> {
    const [owned] = await this.q.select(role, eq(role.id, roleId), { limit: 1 })
    if (!owned) throw new RoleNotInScopeError()
    if (permissionKeys.length === 0) return
    await this.db
      .insert(rolePermission)
      .values(permissionKeys.map(permissionKey => ({ roleId: owned.id, permissionKey })))
      .onConflictDoNothing()
  }

  /** Idempotent. A user or role of another organization is rejected by the composite foreign keys on user_role. */
  async assignToUser(userId: string, roleId: string): Promise<void> {
    await this.q.insert(userRole, { userId, roleId }).onConflictDoNothing()
  }

  async permissionKeysForUser(userId: string): Promise<string[]> {
    // Two independent layers: the composite FKs on user_role (migration 0001) reject a link to
    // another organization's role, and this query still requires role.organization_id to be the
    // scope's organization, so even a corrupt cross-org user_role row can never grant permissions
    // across an organization boundary.
    const rows = await this.db
      .select({ permissionKey: rolePermission.permissionKey })
      .from(userRole)
      .innerJoin(role, eq(role.id, userRole.roleId))
      .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
      .where(and(this.q.cond(userRole, eq(userRole.userId, userId)), this.q.cond(role)))
    return Array.from(new Set(rows.map(r => r.permissionKey)))
  }
}
