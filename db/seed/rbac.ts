import type { DbOrTx } from '../client'
import { platformRepos, tenantRepos } from '../../server/repositories'
import { trustedOrganizationScope } from '../../server/security/scope'
import { PERMISSIONS, PERMISSION_DESCRIPTIONS } from '../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../shared/constants/roles'

export async function seedPermissionCatalog(db: DbOrTx): Promise<void> {
  await platformRepos(db).permissionCatalog.upsertAll(PERMISSIONS.map(key => ({ key, description: PERMISSION_DESCRIPTIONS[key] })))
}

export interface SeedRolesOptions {
  /**
   * Extra permission keys granted on top of a role's normal ROLE_DEFINITIONS set, keyed by role
   * key. Used only for the demo organization's SUPER_ADMIN (organization.resetDemo is demo-only,
   * PF-2/least-privilege: it must never be part of ROLE_DEFINITIONS.SUPER_ADMIN itself, or every
   * organization's Super Admin would hold it).
   */
  extraPermissions?: Partial<Record<string, readonly string[]>>
  /** Stable role ids (Task 20: the demo organization's roles keep the same ids across a reset). Omitted = the database generates them. */
  roleId?: (roleKey: string) => string
}

export async function seedOrganizationRoles(db: DbOrTx, organizationId: string, options: SeedRolesOptions = {}): Promise<Record<string, string>> {
  const { roles } = tenantRepos(db, trustedOrganizationScope(organizationId))
  const roleIdByKey: Record<string, string> = {}

  for (const [key, definition] of Object.entries(ROLE_DEFINITIONS)) {
    const roleRow = await roles.findByKey(key) ?? await roles.insert({ ...(options.roleId ? { id: options.roleId(key) } : {}), key, name: definition.name })
    roleIdByKey[key] = roleRow.id
    const extra = options.extraPermissions?.[key] ?? []
    await roles.grantPermissions(roleRow.id, [...definition.permissions, ...extra])
  }

  return roleIdByKey
}
