import type { OrganizationScope } from '../../security/scope'

/**
 * Runs a periodic sweep for every organization and adds up what it changed. One organization's failure is logged
 * and does not stop the others; the sweep then fails as a whole so the job runner (pg-boss) retries it.
 */
export async function sweepOrganizations(label: string, organizationScopes: readonly OrganizationScope[], sweep: (scope: OrganizationScope) => Promise<number>): Promise<number> {
  let changed = 0
  const failures: unknown[] = []
  for (const scope of organizationScopes) {
    try {
      changed += await sweep(scope)
    }
    catch (error) {
      console.error(`[${label}] sweep failed for organization ${scope.organizationId}:`, error)
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `The ${label} sweep failed for ${failures.length} organization(s)`)
  return changed
}
