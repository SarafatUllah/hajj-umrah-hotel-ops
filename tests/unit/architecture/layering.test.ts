import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findViolations, LAYERING_RULES, parseImports, platformRepositoryClasses, readRepoSources, repositoryClassesOutsideRegisteredDirs, unprefixedPlatformDirClasses } from '../../support/layering'
import { REPOSITORY_BARRELS } from '../../support/repositoryBarrels'

const rulesHit = (sources: Record<string, string>) => findViolations(sources, LAYERING_RULES).map(v => v.rule)

describe('layering checker (meta-tests: the checker itself is tested)', () => {
  it('reports a drizzle-orm import in a service', () => {
    expect(findViolations({ 'server/services/x.ts': 'import { eq } from \'drizzle-orm\'' }, LAYERING_RULES)).toHaveLength(1)
  })

  it('reports db/schema and db/client imports, type-only ones included, in every restricted directory', () => {
    expect(rulesHit({ 'server/api/a.ts': 'import { appUser } from \'../../db/schema\'' })).toEqual(['no-query-building'])
    expect(rulesHit({ 'server/domain/b/c.ts': 'import type { appUser } from \'../../../db/schema/tenancy\'' })).toEqual(['no-query-building'])
    expect(rulesHit({ 'server/utils/other.ts': 'import { createDb } from \'../../db/client\'' })).toEqual(['no-query-building'])
    expect(rulesHit({ 'shared/x.ts': 'import { type SQL } from \'drizzle-orm\'' })).toEqual(['no-query-building'])
    expect(rulesHit({ 'server/services/s.ts': 'import { appUser } from \'~~/db/schema\'' })).toEqual(['no-query-building'])
  })

  it('sees re-exports, dynamic imports, require and import() types', () => {
    expect(rulesHit({ 'shared/x.ts': 'export { pgTable } from \'drizzle-orm/pg-core\'' })).toEqual(['no-query-building'])
    expect(rulesHit({ 'server/api/x.ts': 'export async function f() { return import(\'drizzle-orm\') }' })).toEqual(['no-query-building'])
    expect(rulesHit({ 'server/api/x.ts': 'const d = require(\'../../db/client\')' })).toEqual(['no-query-building'])
    expect(rulesHit({ 'server/services/x.ts': 'type Row = typeof import(\'../../db/schema\').appUser.$inferSelect' })).toEqual(['no-query-building'])
  })

  it('exempts server/utils/db.ts (the client owner) and directories outside the rule', () => {
    expect(rulesHit({ 'server/utils/db.ts': 'import { createDbWithClient } from \'../../db/client\'' })).toEqual([])
    expect(rulesHit({ 'server/repositories/x.ts': 'import { eq } from \'drizzle-orm\'\nimport { appUser } from \'../../db/schema\'' })).toEqual([])
  })

  it('allows trusted* scope minting only in server/security, db/seed and tests — aliased and namespace imports included', () => {
    const mint = 'import { trustedOrganizationScope as t } from \'../security/scope\''
    expect(rulesHit({ 'server/services/x.ts': mint })).toEqual(['scope-minting'])
    // A namespace import reaches every export, so both minting rules report it.
    expect(rulesHit({ 'server/api/x.ts': 'import * as scope from \'../../server/security/scope\'' }).sort()).toEqual(['identity-scope-minting', 'scope-minting'])
    expect(rulesHit({ 'server/repositories/x.ts': 'import { trustedHotelScope } from \'../security/scope\'' })).toEqual(['scope-minting'])
    expect(rulesHit({ 'server/security/tenantResolver.ts': 'import { trustedOrganizationScope } from \'./scope\'' })).toEqual([])
    expect(rulesHit({ 'db/seed/rbac.ts': 'import { trustedOrganizationScope } from \'../../server/security/scope\'' })).toEqual([])
    expect(rulesHit({ 'tests/x.test.ts': 'import { trustedOrganizationScope } from \'../server/security/scope\'' })).toEqual([])
    // The scope *types* are free to import anywhere.
    expect(rulesHit({ 'server/services/x.ts': 'import type { OrganizationScope } from \'../security/scope\'' })).toEqual([])
  })

  it('allows scopeFromIdentity only inside server/security (not even seeds or tests)', () => {
    const imp = 'import { scopeFromIdentity } from \'../security/tenantResolver\''
    expect(rulesHit({ 'server/services/x.ts': imp })).toEqual(['identity-scope-minting'])
    expect(rulesHit({ 'server/repositories/x.ts': imp })).toEqual(['identity-scope-minting'])
    expect(rulesHit({ 'db/seed/x.ts': 'import { scopeFromIdentity } from \'../../server/security/tenantResolver\'' })).toEqual(['identity-scope-minting'])
    expect(rulesHit({ 'tests/x.test.ts': 'import { scopeFromIdentity } from \'../server/security/tenantResolver\'' })).toEqual(['identity-scope-minting'])
    expect(rulesHit({ 'server/security/authContext.ts': 'import { scopeFromIdentity } from \'./tenantResolver\'' })).toEqual([])
    // Other exports of server/security modules stay importable.
    expect(rulesHit({ 'server/services/x.ts': 'import { resolveTenantBySlug } from \'../security/tenantResolver\'' })).toEqual([])
  })

  it('forbids trusted* names re-exported from ANY server/security module, and namespace imports of them', () => {
    expect(rulesHit({ 'server/api/x.ts': 'import { trustedOrganizationScope } from \'../../server/security/tenantResolver\'' })).toEqual(['scope-minting'])
    expect(rulesHit({ 'server/services/x.ts': 'export { trustedHotelScope as h } from \'../security/authorize\'' })).toEqual(['scope-minting'])
    expect(rulesHit({ 'server/services/x.ts': 'import * as security from \'../security/tenantResolver\'' }).sort()).toEqual(['identity-scope-minting', 'scope-minting'])
    expect(rulesHit({ 'db/seed/x.ts': 'import { trustedOrganizationScope } from \'../../server/security/tenantResolver\'' })).toEqual([])
  })

  it('forbids seeds from importing db/schema, but not db/client', () => {
    expect(rulesHit({ 'db/seed/x.ts': 'import { appUser } from \'../schema\'' })).toEqual(['seed-through-repositories'])
    expect(rulesHit({ 'db/seed/demo/x.ts': 'import { room } from \'../../schema/inventory\'' })).toEqual(['seed-through-repositories'])
    expect(rulesHit({ 'db/seed/x.ts': 'import type { DbOrTx } from \'../client\'' })).toEqual([])
  })

  it('reports the line of the offending import, including inside a .vue <script> block', () => {
    const [v] = findViolations({ 'shared/x.ts': 'const a = 1\n\nimport { eq } from \'drizzle-orm\'' }, LAYERING_RULES)
    expect(v?.line).toBe(3)
    const vue = '<template>\n  <div />\n</template>\n<script setup lang="ts">\nimport { trustedOrganizationScope } from \'~~/server/security/scope\'\n</script>\n'
    expect(parseImports('app/pages/x.vue', vue).map(r => [r.target, r.line])).toEqual([['server/security/scope', 5]])
    expect(rulesHit({ 'app/pages/x.vue': vue })).toEqual(['scope-minting'])
  })

  it('finds Platform*Repository classes and platform/ classes without the Platform prefix', () => {
    const sources = {
      'server/repositories/platform/a.ts': 'export class PlatformThingRepository {}\nexport class SneakyRepository {}',
      'server/repositories/tenant/b.ts': 'export class PlatformElsewhereRepository {}',
      'tests/c.ts': 'class PlatformTestRepository {}',
    }
    expect(platformRepositoryClasses(sources)).toEqual(['PlatformElsewhereRepository', 'PlatformThingRepository'])
    expect(unprefixedPlatformDirClasses(sources)).toEqual(['server/repositories/platform/a.ts: SneakyRepository'])
  })
})

describe('repository directory registration (meta-tests)', () => {
  const registered = ['server/repositories/tenant']

  it('reports a class in a repository directory that is not registered', () => {
    expect(repositoryClassesOutsideRegisteredDirs({ 'server/repositories/hotel/roomRepository.ts': 'export class RoomRepository {}' }, registered))
      .toEqual(['server/repositories/hotel/roomRepository.ts: RoomRepository'])
    expect(repositoryClassesOutsideRegisteredDirs({ 'server/repositories/hotel/roomRepository.ts': 'export class RoomRepository {}' }, [...registered, 'server/repositories/hotel']))
      .toEqual([])
  })

  it('reports classes directly in server/repositories/ or in a nested directory of a registered one', () => {
    expect(repositoryClassesOutsideRegisteredDirs({
      'server/repositories/fooRepository.ts': 'export class FooRepository {}',
      'server/repositories/tenant/nested/barRepository.ts': 'export class BarRepository {}',
    }, registered)).toEqual(['server/repositories/fooRepository.ts: FooRepository', 'server/repositories/tenant/nested/barRepository.ts: BarRepository'])
  })

  it('accepts base/, platform/ and registered directories, and ignores the word "class" in comments and strings', () => {
    expect(repositoryClassesOutsideRegisteredDirs({
      'server/repositories/base/scopedQuery.ts': 'export class OrgQuery {}',
      'server/repositories/platform/x.ts': 'export class PlatformXRepository {}',
      'server/repositories/tenant/y.ts': 'export class YRepository {}\nexport class YError extends Error {}',
      'server/repositories/index.ts': '// the class of repositories\nconst s = \'class Fake\'',
    }, registered)).toEqual([])
  })
})

describe('layering of this repository', () => {
  const sources = readRepoSources(join(import.meta.dirname, '../../..'))
  const violationsOf = (rule: string) => findViolations(sources, LAYERING_RULES.filter(r => r.id === rule))

  it('reads the real source tree', () => {
    expect(Object.keys(sources)).toEqual(expect.arrayContaining(['server/services/auth.service.ts', 'server/security/scope.ts', 'db/seed/rbac.ts']))
  })

  it('(a) services, api, domain, utils and shared never import drizzle-orm, db/schema or db/client (server/utils/db.ts excepted)', () => {
    expect(violationsOf('no-query-building')).toEqual([])
  })

  it('(b) trusted* scope minting is imported only from server/security, db/seed and tests', () => {
    expect(violationsOf('scope-minting')).toEqual([])
  })

  it('(b) scopeFromIdentity is imported only inside server/security', () => {
    expect(violationsOf('identity-scope-minting')).toEqual([])
  })

  it('(c) seeds do not import db/schema (they write through repositories)', () => {
    expect(violationsOf('seed-through-repositories')).toEqual([])
  })

  it('(f) every class under server/repositories/ is in base/, platform/ or a registered barrel directory', () => {
    expect(repositoryClassesOutsideRegisteredDirs(sources, REPOSITORY_BARRELS.map(b => b.dir))).toEqual([])
  })

  it('(d) the unscoped Platform*Repository classes are exactly the allow-list', () => {
    expect(platformRepositoryClasses(sources)).toEqual(['PlatformOrganizationRepository', 'PlatformPermissionCatalogRepository'])
    expect(unprefixedPlatformDirClasses(sources)).toEqual([])
  })
})
