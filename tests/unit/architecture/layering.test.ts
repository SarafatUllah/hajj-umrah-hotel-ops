import { describe, expect, it } from 'vitest'
import { findViolations, LAYERING_RULES, parseImports, platformRepositoryClasses, unprefixedPlatformDirClasses } from '../../support/layering'

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
    expect(rulesHit({ 'server/api/x.ts': 'import * as scope from \'../../server/security/scope\'' })).toEqual(['scope-minting'])
    expect(rulesHit({ 'server/repositories/x.ts': 'import { trustedHotelScope } from \'../security/scope\'' })).toEqual(['scope-minting'])
    expect(rulesHit({ 'server/security/tenantResolver.ts': 'import { trustedOrganizationScope } from \'./scope\'' })).toEqual([])
    expect(rulesHit({ 'db/seed/rbac.ts': 'import { trustedOrganizationScope } from \'../../server/security/scope\'' })).toEqual([])
    expect(rulesHit({ 'tests/x.test.ts': 'import { trustedOrganizationScope } from \'../server/security/scope\'' })).toEqual([])
    // The scope *types* are free to import anywhere.
    expect(rulesHit({ 'server/services/x.ts': 'import type { OrganizationScope } from \'../security/scope\'' })).toEqual([])
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
