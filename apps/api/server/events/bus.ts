import { randomUUID } from 'node:crypto'
import type { DomainEvent } from '@hajj/contracts/events/domainEvents'
import type { tenantRepos } from '../repositories'

/** The transaction an event is published in (its handlers' jobs are written in it). */
type Tx = Parameters<typeof tenantRepos>[0]

/** Hands an event to the job runtime inside the publisher's transaction (one job per handler). */
export type EventSink = (tx: Tx, event: DomainEvent) => Promise<void>

let sink: EventSink | null = null

/** Wired once the job runtime is up (`server/jobs/eventJobs.ts`); replaced in tests. */
export function setEventSink(next: EventSink | null): void {
  sink = next
}

/** A new event: its id and time are stamped here. */
export function newEvent<E extends DomainEvent>(type: E['type'], version: E['version'], organizationId: string, payload: E['payload'], now: Date): E {
  return { type, version, eventId: randomUUID(), occurredAt: now.toISOString(), organizationId, payload } as E
}

/**
 * Publishes `event` in the caller's transaction (ticket 7): its handlers' jobs commit or roll back with the change
 * itself, so a handler never sees a change that did not happen and never misses one that did. A process without a
 * job runtime (`JOBS_MODE=off`) logs the event and drops it — events carry side effects only, never rules.
 */
export async function publishEvent(tx: Tx, event: DomainEvent): Promise<void> {
  if (!sink) {
    console.error(`[events] ${event.type} ${event.eventId} dropped: this process has no job runtime (JOBS_MODE=off)`)
    return
  }
  await sink(tx, event)
}
