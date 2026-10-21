import { tenantRepos } from '../repositories'
import type { AuthContext } from '../security/authContext'

export interface SessionOrganization {
  id: string
  name: string
  slug: string
  isDemo: boolean
}

export interface SessionRole {
  key: string
  name: string
}

export interface SessionContext {
  organization: SessionOrganization
  roles: SessionRole[]
}

/**
 * S1: the caller's own organization and role display data — deliberately NOT part of
 * resolveAuthContext (which stays at exactly three queries: user, permissions, hotel ids). This runs
 * only for the `me` endpoint, where the extra two queries (organization, roles) are worth paying for
 * display purposes.
 */
export async function getSessionContext(ctx: AuthContext): Promise<SessionContext> {
  const repos = tenantRepos(ctx.db, ctx.scope)

  const [organization, roles] = await Promise.all([
    repos.organization.getOwn(),
    repos.roles.rolesForUser(ctx.identity.userId),
  ])

  return {
    organization: { id: organization.id, name: organization.name, slug: organization.slug, isDemo: organization.isDemo },
    roles,
  }
}
