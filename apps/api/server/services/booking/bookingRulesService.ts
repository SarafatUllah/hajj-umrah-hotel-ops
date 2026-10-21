import type { Permission } from '@hajj/contracts/constants/permissions'
import { BOOKING_RULE_FIELDS, BOOKING_RULE_SCHEMAS, type BookingRuleKind } from '@hajj/contracts/schemas/bookingRules'
import type { BookingRuleDto } from '@hajj/contracts/types/bookingRules'
import { rethrowDbError } from '../../errors/dbErrors'
import { NotFoundError } from '../../errors/domainError'
import { bookingRepos, tenantRepos } from '../../repositories'
import type { RuleStore } from '../../repositories/booking'
import type { AuthContext } from '../../security/authContext'
import { authorizeHotel } from '../../security/authorize'
import type { OrganizationScope } from '../../security/scope'
import { findAgencyNames } from '../accounts'
import { recordAudit } from '../audit'

type StoredRule = Record<string, unknown> & { id: string }
/** The database handle a repository accepts (a service may not import db/client itself). */
type Db = Parameters<typeof bookingRepos>[0]

interface RuleKindConfig {
  /** Reading the rules (managers and the booking screens) and changing them. */
  view: Permission
  manage: Permission
  entityType: string
  /** The table's repository, seen through the plain-row `RuleStore` interface (each kind's schema matches its columns). */
  repo: (repos: ReturnType<typeof bookingRepos>) => RuleStore
}

/** Each concrete rule repository satisfies `RuleStore`; the cast only widens its precise row types to plain records. */
const asStore = (repo: unknown) => repo as RuleStore

/** Rates use the existing rate permissions; the other rules are booking settings (v7 §15). */
const KINDS: Record<BookingRuleKind, RuleKindConfig> = {
  'rates': { view: 'rate.view', manage: 'rate.manage', entityType: 'rate', repo: r => asStore(r.rates) },
  'agency-quotas': { view: 'booking.view', manage: 'booking.settings', entityType: 'agency_quota', repo: r => asStore(r.agencyQuotas) },
  'allocation-rules': { view: 'booking.view', manage: 'booking.settings', entityType: 'allocation_rule', repo: r => asStore(r.allocationRules) },
  'extra-bed-policies': { view: 'booking.view', manage: 'booking.settings', entityType: 'extra_bed_policy', repo: r => asStore(r.extraBedPolicies) },
}

/** A stored rule without its tenancy or authorship columns, timestamps as ISO strings (also what the audit keeps). */
function toRuleDto(row: StoredRule): StoredRule {
  const dto: StoredRule = { id: row.id }
  for (const [key, value] of Object.entries(row)) {
    if (key === 'organizationId' || key === 'hotelId' || key === 'createdBy') continue
    dto[key] = value instanceof Date ? value.toISOString() : value
  }
  return dto
}

/**
 * Rules as the API returns them (`@hajj/contracts/types/bookingRules`; each kind's columns are its response type's
 * fields, checked in `tests/types`): a quota also names its agency (null for the default), one query for them all.
 */
async function presentRules<K extends BookingRuleKind>(db: Db, scope: OrganizationScope, kind: K, rows: readonly StoredRule[]): Promise<Array<BookingRuleDto<K>>> {
  const dtos = rows.map(toRuleDto)
  if (kind !== 'agency-quotas') return dtos as unknown as Array<BookingRuleDto<K>>
  const agencyOf = (dto: StoredRule) => (typeof dto.agencyId === 'string' ? dto.agencyId : null)
  const names = await findAgencyNames(db, scope, dtos.map(agencyOf).filter((id): id is string => id !== null))
  const named = dtos.map((dto) => {
    const agencyId = agencyOf(dto)
    return { ...dto, agencyName: agencyId === null ? null : names.get(agencyId) ?? null }
  })
  return named as unknown as Array<BookingRuleDto<K>>
}
const presentRule = async <K extends BookingRuleKind>(db: Db, scope: OrganizationScope, kind: K, row: StoredRule): Promise<BookingRuleDto<K>> => (await presentRules(db, scope, kind, [row]))[0]!

export async function listBookingRules<K extends BookingRuleKind>(ctx: AuthContext, hotelId: string, kind: K): Promise<Array<BookingRuleDto<K>>> {
  const config = KINDS[kind]
  const { scope } = await authorizeHotel(ctx, config.view, hotelId, { allowInactive: true })
  return presentRules(ctx.db, scope, kind, await config.repo(bookingRepos(ctx.db, scope)).list())
}

/**
 * Adds a rule (`body` validated with the kind's schema). Overlapping seasons or group ranges are refused by the
 * table's exclusion constraint (409 `RANGE_OVERLAP`), a second extra-bed policy for a room type by its unique key
 * (409 `ALREADY_EXISTS`), a room type or agency of another organization by its foreign key (422). Audited.
 */
export async function createBookingRule<K extends BookingRuleKind>(ctx: AuthContext, hotelId: string, kind: K, body: unknown): Promise<BookingRuleDto<K>> {
  const config = KINDS[kind]
  const { hotel, scope } = await authorizeHotel(ctx, config.manage, hotelId)
  const values = BOOKING_RULE_SCHEMAS[kind].parse(body) as Record<string, unknown>
  return ctx.db.transaction(async (tx) => {
    const row = await config.repo(bookingRepos(tx, scope)).insert({ ...values, ...(kind === 'rates' ? { createdBy: ctx.identity.userId } : {}) })
    const dto = toRuleDto(row)
    await recordAudit(tenantRepos(tx, ctx.scope).audit, ctx.identity.userId, { hotelId: hotel.id, entityType: config.entityType, entityId: dto.id, action: 'BOOKING_RULE_CREATED', after: dto })
    return presentRule(tx, scope, kind, row)
  }).catch(rethrowDbError)
}

/**
 * Edits a rule: the patch is merged onto the stored rule (row-locked, so concurrent edits serialize) and the
 * result validated as a whole — an unknown key (e.g. `hotelId`) is a 422. A patch that changes nothing writes
 * nothing. Audited with before/after.
 */
export async function updateBookingRule<K extends BookingRuleKind>(ctx: AuthContext, hotelId: string, kind: K, ruleId: string, patch: Record<string, unknown>): Promise<BookingRuleDto<K>> {
  const config = KINDS[kind]
  const { hotel, scope } = await authorizeHotel(ctx, config.manage, hotelId)
  return ctx.db.transaction(async (tx) => {
    const repo = config.repo(bookingRepos(tx, scope))
    const current = await repo.findById(ruleId, { forUpdate: true })
    if (!current) throw new NotFoundError('BOOKING_RULE_NOT_FOUND')
    const keys = Object.keys(BOOKING_RULE_FIELDS[kind].shape)
    const values = BOOKING_RULE_SCHEMAS[kind].parse({ ...Object.fromEntries(keys.map(key => [key, current[key]])), ...patch }) as Record<string, unknown>
    if (keys.every(key => values[key] === current[key])) return presentRule(tx, scope, kind, current)

    const updated = (await repo.update(ruleId, values))!
    const [before, after] = [toRuleDto(current), toRuleDto(updated)]
    await recordAudit(tenantRepos(tx, ctx.scope).audit, ctx.identity.userId, { hotelId: hotel.id, entityType: config.entityType, entityId: ruleId, action: 'BOOKING_RULE_UPDATED', before, after })
    return presentRule(tx, scope, kind, updated)
  }).catch(rethrowDbError)
}

export async function deleteBookingRule(ctx: AuthContext, hotelId: string, kind: BookingRuleKind, ruleId: string): Promise<{ id: string }> {
  const config = KINDS[kind]
  const { hotel, scope } = await authorizeHotel(ctx, config.manage, hotelId)
  return ctx.db.transaction(async (tx) => {
    const repo = config.repo(bookingRepos(tx, scope))
    const current = await repo.findById(ruleId, { forUpdate: true })
    if (!current || !await repo.delete(ruleId)) throw new NotFoundError('BOOKING_RULE_NOT_FOUND')
    await recordAudit(tenantRepos(tx, ctx.scope).audit, ctx.identity.userId, { hotelId: hotel.id, entityType: config.entityType, entityId: ruleId, action: 'BOOKING_RULE_DELETED', before: toRuleDto(current) })
    return { id: ruleId }
  })
}
