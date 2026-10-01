import { ConflictError, ValidationError, type DomainError } from './domainError'

/** The subset of a real Postgres error (as reported by the `postgres` driver) that translation needs. */
export interface PgErrorInfo {
  code: string
  constraint?: string
  table?: string
  detail?: string
}

// Drizzle's postgres-js driver wraps every failed query in a
// `DrizzleQueryError`, which carries the original driver error on `.cause` —
// `DrizzleQueryError` itself has no `.code`. A cyclic `.cause` chain must
// never spin forever, so unwrapping is capped at a small, fixed depth.
const MAX_CAUSE_DEPTH = 4

function isPgErrorLike(value: unknown): value is { code: string, constraint_name?: string, table_name?: string, detail?: string } {
  return typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string'
}

/**
 * Unwraps `err` (and, up to `MAX_CAUSE_DEPTH` levels, its `.cause` chain)
 * looking for a Postgres-shaped error (a `code`/SQLSTATE, plus the optional
 * `constraint_name`/`table_name`/`detail` fields the wire protocol attaches).
 * Returns `null` for anything else, including a plain `Error` with no cause.
 */
export function extractPgError(err: unknown): PgErrorInfo | null {
  let current: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || current === undefined) return null
    if (isPgErrorLike(current)) {
      return {
        code: current.code,
        constraint: current.constraint_name,
        table: current.table_name,
        detail: current.detail,
      }
    }
    if (!(current instanceof Error)) return null
    current = current.cause
  }
  return null
}

/**
 * Per-constraint overrides. Keyed by the Postgres constraint name (stable
 * across environments, unlike message text). `kind` must agree with the
 * SQLSTATE family the constraint belongs to (`conflict` for a unique
 * violation, `validation` for a foreign-key/check violation) — it only
 * refines the `code`/`message` that the generic SQLSTATE mapping below would
 * otherwise produce. Each later schema task adds its own entries here.
 */
export const CONSTRAINT_MESSAGES: Record<string, { kind: 'conflict' | 'validation', code: string, message: string }> = {
  organization_slug_unique: { kind: 'conflict', code: 'ORGANIZATION_SLUG_TAKEN', message: 'An organization with this slug already exists' },
  app_user_org_email_unique: { kind: 'conflict', code: 'USER_EMAIL_TAKEN', message: 'A user with this email already exists in this organization' },
  // Unique violation (23505) -> kind must be 'conflict' to agree with the SQLSTATE-derived generic
  // kind, or translateDbError rejects this entry outright (Task 5 rule). Code is the generic
  // ALREADY_EXISTS (Task 12 ruling PF-13-adjacent) rather than a bespoke HOTEL_CODE_TAKEN, so every
  // later aggregate's duplicate-key conflict reads the same machine code; the message stays specific.
  hotel_org_code_unique: { kind: 'conflict', code: 'ALREADY_EXISTS', message: 'A hotel with this code already exists' },
  // Task 13: same rule — the constraint's SQLSTATE is 23505 (unique_violation), so kind must be 'conflict'.
  floor_hotel_level_unique: { kind: 'conflict', code: 'ALREADY_EXISTS', message: 'A floor with this level already exists in this hotel' },
  room_type_org_code_unique: { kind: 'conflict', code: 'ALREADY_EXISTS', message: 'A room type with this code already exists' },
  // Task 14: room numbers are unique per hotel for the room's entire lifetime (a retired room's
  // number stays reserved), so this fires both on true duplicate-create races AND on reusing a
  // retired room's number — both are the same generic ALREADY_EXISTS conflict.
  room_hotel_number_unique: { kind: 'conflict', code: 'ALREADY_EXISTS', message: 'A room with this number already exists in this hotel' },
  // Task 14: exclusion_violation (23P01), not unique_violation — kind must be 'conflict' to agree
  // with the SQLSTATE-derived generic kind for 23P01 (see SQLSTATE_MAP below), or translateDbError
  // rejects this entry outright (Task 5 rule). Fires when a base-config version would overlap an
  // existing one for the same room (the DB's exclusion constraint is the final arbiter against
  // concurrent base changes).
  room_base_config_no_overlap: { kind: 'conflict', code: 'RANGE_OVERLAP', message: 'This base-configuration change overlaps an existing version for this room' },
  // Task 15: a capacity period's name must be unique per hotel (23505 unique_violation -> kind 'conflict').
  capacity_period_hotel_name_unique: { kind: 'conflict', code: 'ALREADY_EXISTS', message: 'A capacity period with this name already exists in this hotel' },
  // Task 15: exclusion_violation (23P01), same technique as room_base_config_no_overlap — fires when
  // a room override would overlap another override of the same room (same period being extended into
  // another period's override, or two overlapping periods applied to the same room).
  room_override_no_overlap: { kind: 'conflict', code: 'RANGE_OVERLAP', message: 'This change would give a room two capacity overrides on the same night' },
  // Task 15: foreign_key_violation (23503) — an override whose dates have drifted from its period's
  // own (organization_id, hotel_id, period_id, valid_from, valid_to) is structurally impossible to
  // insert/update without violating this composite FK first.
  room_override_period_dates_fk: { kind: 'validation', code: 'INVALID_REFERENCE', message: 'An override\'s dates must match its capacity period\'s dates' },
}

/** Generic mapping by SQLSTATE, applied before the per-constraint registry above. */
const SQLSTATE_MAP: Record<string, { kind: 'conflict' | 'validation' | 'internal', code: string }> = {
  '23505': { kind: 'conflict', code: 'ALREADY_EXISTS' }, // unique_violation
  '23P01': { kind: 'conflict', code: 'RANGE_OVERLAP' }, // exclusion_violation
  '23503': { kind: 'validation', code: 'INVALID_REFERENCE' }, // foreign_key_violation
  '23514': { kind: 'validation', code: 'CONSTRAINT_VIOLATION' }, // check_violation
  '55000': { kind: 'internal', code: 'IMMUTABLE_AUDIT_VIOLATION' }, // object_not_in_prerequisite_state (immutable audit rows)
}

/**
 * Translates a real (or realistically shaped) database error into a
 * `DomainError`, or returns `null` when `err` is not a recognized database
 * error — callers rethrow the original error in that case so it surfaces as
 * an internal error instead of being silently swallowed.
 */
export function translateDbError(err: unknown): DomainError | null {
  const pg = extractPgError(err)
  if (!pg) return null

  const generic = SQLSTATE_MAP[pg.code]
  if (!generic) return null
  // 55000 (an attempted UPDATE/DELETE of an immutable audit row) is a bug in
  // our own code, not a client-facing condition — it surfaces as a generic
  // internal error instead of a translated DomainError.
  if (generic.kind === 'internal') return null

  const specific = pg.constraint ? CONSTRAINT_MESSAGES[pg.constraint] : undefined
  // SQLSTATE is the sole authority for which DomainError subclass gets
  // thrown. The registry may only refine `code`/`message`, never the
  // error class — a `CONSTRAINT_MESSAGES` entry whose declared `kind`
  // disagrees with the SQLSTATE-derived `kind` is a config/programmer
  // error, not a translatable condition: treat it as unrecognized so it
  // falls through apiHandler's normal internal/unknown-error path
  // (logged, generic 500) instead of silently trusting either side.
  if (specific && specific.kind !== generic.kind) return null

  const code = specific?.code ?? generic.code
  const message = specific?.message ?? code

  return generic.kind === 'conflict' ? new ConflictError(code, message) : new ValidationError(code, message)
}
