/**
 * Who a session belongs to (design v7 §21: one API, three kinds of principal). Staff use the operations
 * console; agency users and customers arrive with their own tables and login flows (Phase 2a accounts).
 * Every route group checks the kind itself, whatever domain the request came from.
 */
export const PRINCIPAL_KINDS = ['staff', 'agency', 'customer'] as const

export type PrincipalKind = typeof PRINCIPAL_KINDS[number]

/** Who did something, in logs and change records: a principal, or the system itself (jobs, sweeps). */
export const ACTOR_KINDS = [...PRINCIPAL_KINDS, 'system'] as const

export type ActorKind = typeof ACTOR_KINDS[number]
