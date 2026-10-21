import type { DomainEvent } from '@hajj/contracts/events/domainEvents'
import { tenantRepos } from '../repositories'
import { organizationScopeById } from '../security/organizations'
import type { OrganizationScope } from '../security/scope'

type Db = Parameters<typeof tenantRepos>[0]

/** What one handler does with one event, inside its own transaction. */
export type EventHandle<E extends DomainEvent> = (tx: Db, scope: OrganizationScope, event: E) => Promise<void>

/** Receipts are kept well past the event jobs' last retry (5 retries with backoff: hours, not days). */
const RECEIPT_RETENTION_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Runs `handle` for `event` once per (event, handler) — ticket 7's idempotency: the handler claims its receipt in
 * the transaction of its own database effects, so a duplicated or retried delivery changes nothing twice, and a
 * handler that throws gives the claim back (the job is retried). An outside effect (a text message) is at least
 * once: sent, then the commit fails, and the retry sends it again. An event of an organization that no longer exists
 * is dropped.
 */
export async function handleEventOnce<E extends DomainEvent>(db: Db, event: E, handler: string, handle: EventHandle<E>): Promise<void> {
  const scope = await organizationScopeById(db, event.organizationId)
  if (!scope) return
  await db.transaction(async (tx) => {
    if (!(await tenantRepos(tx, scope).eventReceipts.claim(event.eventId, handler))) return
    await handle(tx, scope, event)
  })
}

/** The daily prune of old receipts, per organization. */
export async function pruneEventReceipts(db: Db, scopes: readonly OrganizationScope[], now: Date): Promise<number> {
  const before = new Date(now.getTime() - RECEIPT_RETENTION_DAYS * MS_PER_DAY)
  let pruned = 0
  for (const scope of scopes) pruned += await tenantRepos(db, scope).eventReceipts.deleteProcessedBefore(before)
  return pruned
}
