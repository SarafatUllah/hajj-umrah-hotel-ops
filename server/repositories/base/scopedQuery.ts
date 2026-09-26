import { and, eq, type SQL } from 'drizzle-orm'
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core'
import type { DbOrTx } from '../../../db/client'
import type { HotelScope, OrganizationScope } from '../../security/scope'

type OrgTable = PgTable & { organizationId: AnyPgColumn }
type HotelTable = OrgTable & { hotelId: AnyPgColumn }

type InsertOf<T extends PgTable> = T['$inferInsert']

export interface SelectOptions { orderBy?: SQL[], limit?: number, offset?: number }

async function run<T extends PgTable>(db: DbOrTx, table: T, where: SQL, o: SelectOptions = {}): Promise<Array<T['$inferSelect']>> {
  // Drizzle's conditional `from()` typing cannot be satisfied by a generic table, so the row type is restated here.
  let q = db.select().from(table as PgTable).where(where).$dynamic()
  if (o.orderBy?.length) q = q.orderBy(...o.orderBy)
  if (o.limit !== undefined) q = q.limit(o.limit)
  if (o.offset !== undefined) q = q.offset(o.offset)
  return (await q) as Array<T['$inferSelect']>
}


/** Every statement it builds carries the organization predicate; inserts cannot choose their own organization. */
export class OrgQuery {
  constructor(protected readonly db: DbOrTx, readonly scope: OrganizationScope) {}

  protected orgCond(table: OrgTable): SQL {
    return eq(table.organizationId, this.scope.organizationId)
  }

  cond<T extends OrgTable>(table: T, ...extra: Array<SQL | undefined>): SQL {
    return and(this.orgCond(table), ...extra)!
  }

  select<T extends OrgTable>(table: T, where?: SQL, options?: SelectOptions) {
    return run(this.db, table, this.cond(table, where), options)
  }

  insert<T extends OrgTable>(table: T, values: Omit<InsertOf<T>, 'organizationId'>) {
    return this.db.insert(table).values({ ...values, organizationId: this.scope.organizationId } as InsertOf<T>)
  }

  update<T extends OrgTable>(table: T, set: Partial<Omit<InsertOf<T>, 'organizationId' | 'id'>>, ...extra: Array<SQL | undefined>) {
    return this.db.update(table).set(set as never).where(this.cond(table, ...extra))
  }

  delete<T extends OrgTable>(table: T, ...extra: Array<SQL | undefined>) {
    return this.db.delete(table).where(this.cond(table, ...extra))
  }
}

/** Adds the hotel predicate on top of the organization predicate; inserts cannot choose organization or hotel. */
export class HotelQuery {
  constructor(protected readonly db: DbOrTx, readonly scope: HotelScope) {}

  cond<T extends HotelTable>(table: T, ...extra: Array<SQL | undefined>): SQL {
    return and(eq(table.organizationId, this.scope.organizationId), eq(table.hotelId, this.scope.hotelId), ...extra)!
  }

  select<T extends HotelTable>(table: T, where?: SQL, options?: SelectOptions) {
    return run(this.db, table, this.cond(table, where), options)
  }

  insert<T extends HotelTable>(table: T, values: Omit<InsertOf<T>, 'organizationId' | 'hotelId'>) {
    return this.db.insert(table).values({ ...values, organizationId: this.scope.organizationId, hotelId: this.scope.hotelId } as InsertOf<T>)
  }

  update<T extends HotelTable>(table: T, set: Partial<Omit<InsertOf<T>, 'organizationId' | 'hotelId' | 'id'>>, ...extra: Array<SQL | undefined>) {
    return this.db.update(table).set(set as never).where(this.cond(table, ...extra))
  }

  delete<T extends HotelTable>(table: T, ...extra: Array<SQL | undefined>) {
    return this.db.delete(table).where(this.cond(table, ...extra))
  }
}
