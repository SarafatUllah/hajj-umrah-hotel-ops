import { and, eq } from 'drizzle-orm'
import { appUser, auditLog, role, rolePermission, userRole } from '../../../db/schema'
import type { DbOrTx } from '../../../db/client'
import type { OrganizationScope } from '../../../server/security/scope'
import { AuditRepository, RoleNotInScopeError, RoleRepository, UserRepository } from '../../../server/repositories/tenant'
import { ensurePermissions, makeRole, makeUser, makeUserWithPermissions } from '../../support/fixtures'

/**
 * Behavioral tenant-isolation registry: one entry per `ClassName.method` of every scoped repository.
 * `tenantIsolation.test.ts` runs each case twice on fresh data:
 *   - as org B with org A's ids: the call must be isolated (`expect`), and `unchanged` (if given) must hold;
 *   - as org A with its own ids (positive control): the call must NOT look isolated, which proves the
 *     arrange step really created something to leak and the call itself works.
 * The coverage test fails if a repository exported from a barrel below has a method without an entry.
 */
export type IsolationExpectation = 'empty' | 'null' | 'zero-affected' | 'rejects'

export interface IsolationCase<Ids> {
  /** Label for multi-case entries. */
  name?: string
  /** Creates org A's data and returns the ids an attacker in org B would try. */
  arrange: (db: DbOrTx, orgA: OrganizationScope) => Promise<Ids>
  /** Calls the method under `scope`. For inserts, returns what landed in org A (so a smuggled organization shows up as a row). */
  act: (db: DbOrTx, scope: OrganizationScope, ids: Ids) => Promise<unknown>
  expect: IsolationExpectation
  /** For 'rejects': the rejection must be for this reason (not an unrelated error). */
  rejection?: (error: unknown) => boolean
  /** Runs after the org B call: org A's data must be exactly as arranged. */
  unchanged?: (db: DbOrTx, ids: Ids) => Promise<void>
}

type AnyCase = IsolationCase<unknown>
const isolationCase = <Ids>(c: IsolationCase<Ids>): AnyCase => c as unknown as AnyCase

export { REPOSITORY_BARRELS } from '../../support/repositoryBarrels'

function pgCode(error: unknown): string | undefined {
  for (let e = error as { code?: unknown, cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (typeof e.code === 'string') return e.code
  }
  return undefined
}
const foreignKeyViolation = (error: unknown) => pgCode(error) === '23503'

async function assertNoRows(rows: unknown[], what: string) {
  if (rows.length !== 0) throw new Error(`${what}: expected no rows, found ${rows.length}`)
}

export const ISOLATION_REGISTRY: Record<string, AnyCase | AnyCase[]> = {
  'UserRepository.findActiveByEmail': isolationCase({
    arrange: async (db, orgA) => ({ email: (await makeUser(db, orgA)).email }),
    act: (db, scope, ids) => new UserRepository(db, scope).findActiveByEmail(ids.email),
    expect: 'null',
  }),
  'UserRepository.findByEmail': isolationCase({
    arrange: async (db, orgA) => ({ email: (await makeUser(db, orgA, { isActive: false })).email }),
    act: (db, scope, ids) => new UserRepository(db, scope).findByEmail(ids.email),
    expect: 'null',
  }),
  'UserRepository.findById': isolationCase({
    arrange: async (db, orgA) => ({ userId: (await makeUser(db, orgA)).id }),
    act: (db, scope, ids) => new UserRepository(db, scope).findById(ids.userId),
    expect: 'null',
  }),
  'UserRepository.insert': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new UserRepository(db, scope).insert({ organizationId: ids.orgAId, email: 'planted@example.test', passwordHash: 'x', fullName: 'Planted' } as never)
      return db.select().from(appUser).where(and(eq(appUser.organizationId, ids.orgAId), eq(appUser.email, 'planted@example.test')))
    },
    expect: 'empty',
  }),

  'RoleRepository.findByKey': isolationCase({
    arrange: async (db, orgA) => ({ key: (await makeRole(db, orgA)).key }),
    act: (db, scope, ids) => new RoleRepository(db, scope).findByKey(ids.key),
    expect: 'null',
  }),
  'RoleRepository.insert': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new RoleRepository(db, scope).insert({ organizationId: ids.orgAId, key: 'PLANTED', name: 'Planted' } as never)
      return db.select().from(role).where(and(eq(role.organizationId, ids.orgAId), eq(role.key, 'PLANTED')))
    },
    expect: 'empty',
  }),
  // role_permission has no organization_id (PF-15): the method must refuse a role outside the scope.
  'RoleRepository.grantPermissions': isolationCase({
    arrange: async (db, orgA) => {
      await ensurePermissions(db, ['probe.grant'])
      return { roleId: (await makeRole(db, orgA)).id }
    },
    act: (db, scope, ids) => new RoleRepository(db, scope).grantPermissions(ids.roleId, ['probe.grant']),
    expect: 'rejects',
    rejection: error => error instanceof RoleNotInScopeError,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(rolePermission).where(eq(rolePermission.roleId, ids.roleId)), 'role_permission of org A\'s role'),
  }),
  'RoleRepository.assignToUser': [
    isolationCase({
      name: 'org A user to org A role',
      arrange: async (db, orgA) => ({ userId: (await makeUser(db, orgA)).id, roleId: (await makeRole(db, orgA)).id }),
      act: (db, scope, ids) => new RoleRepository(db, scope).assignToUser(ids.userId, ids.roleId),
      expect: 'rejects',
      rejection: foreignKeyViolation,
      unchanged: async (db, ids) => assertNoRows(await db.select().from(userRole).where(eq(userRole.userId, ids.userId)), 'user_role of org A\'s user'),
    }),
    isolationCase({
      name: 'caller\'s own user to org A role',
      arrange: async (db, orgA) => ({ roleId: (await makeRole(db, orgA)).id }),
      act: async (db, scope, ids) => new RoleRepository(db, scope).assignToUser((await makeUser(db, scope)).id, ids.roleId),
      expect: 'rejects',
      rejection: foreignKeyViolation,
      unchanged: async (db, ids) => assertNoRows(await db.select().from(userRole).where(eq(userRole.roleId, ids.roleId)), 'user_role of org A\'s role'),
    }),
  ],
  // Joins role_permission (no organization_id, PF-15) only through org-scoped user_role and role predicates.
  'RoleRepository.permissionKeysForUser': isolationCase({
    arrange: async (db, orgA) => ({ userId: (await makeUserWithPermissions(db, orgA, ['probe.read'])).user.id }),
    act: (db, scope, ids) => new RoleRepository(db, scope).permissionKeysForUser(ids.userId),
    expect: 'empty',
  }),

  'AuditRepository.record': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new AuditRepository(db, scope).record({ organizationId: ids.orgAId, entityType: 'probe', entityId: 'probe', action: 'PROBE' } as never)
      return db.select().from(auditLog).where(eq(auditLog.organizationId, ids.orgAId))
    },
    expect: 'empty',
  }),
}

export function registryCases(): Array<{ key: string, case: AnyCase }> {
  return Object.entries(ISOLATION_REGISTRY).flatMap(([key, entry]) => [entry].flat().map(c => ({ key: c.name ? `${key} (${c.name})` : key, case: c })))
}

/** `ClassName.method` for every prototype method (inherited ones included) of every exported `*Repository` class. */
export function repositoryMethodKeys(barrels: ReadonlyArray<Record<string, unknown>>): string[] {
  const keys = new Set<string>()
  for (const barrel of barrels) {
    for (const [name, value] of Object.entries(barrel)) {
      if (!name.endsWith('Repository') || typeof value !== 'function') continue
      for (let proto = value.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const method of Object.getOwnPropertyNames(proto)) {
          if (method === 'constructor') continue
          if (typeof Object.getOwnPropertyDescriptor(proto, method)?.value === 'function') keys.add(`${name}.${method}`)
        }
      }
    }
  }
  return [...keys].sort()
}

export function coverageGaps(barrels: ReadonlyArray<Record<string, unknown>>, registry: Record<string, unknown>): { missing: string[], stale: string[] } {
  const methods = repositoryMethodKeys(barrels)
  const registered = Object.keys(registry)
  return {
    missing: methods.filter(k => !registered.includes(k)),
    stale: registered.filter(k => !methods.includes(k)).sort(),
  }
}
