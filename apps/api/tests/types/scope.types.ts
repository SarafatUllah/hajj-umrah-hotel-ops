import { eq } from 'drizzle-orm'
import { appUser, role } from '../../db/schema'
import type { DbOrTx } from '../../db/client'
import { OrgQuery } from '../../server/repositories/base/scopedQuery'
import { trustedOrganizationScope } from '../../server/security/scope'

/** Compile-only: `pnpm typecheck:types` must pass, which proves the two @ts-expect-error lines really are errors. */
export async function demo(db: DbOrTx) {
  const q = new OrgQuery(db, trustedOrganizationScope('00000000-0000-0000-0000-000000000000'))
  const rows = await q.select(appUser, eq(appUser.isActive, true))
  const first: string | undefined = rows[0]?.email
  await q.insert(appUser, { email: 'a@b.c', passwordHash: 'x', fullName: 'A' })
  await q.update(appUser, { isActive: false }, eq(appUser.email, 'a@b.c'))
  await q.delete(role, eq(role.key, 'X'))
  // @ts-expect-error organizationId must not be caller-supplied on insert
  await q.insert(appUser, { organizationId: 'other', email: 'a@b.c', passwordHash: 'x', fullName: 'A' })
  // @ts-expect-error a table without organization_id (the global permission catalog) cannot be queried through a tenant query
  await q.select((await import('../../db/schema')).permission)
  return first
}
