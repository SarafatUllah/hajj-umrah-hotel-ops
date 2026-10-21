import type { DomainEvent, DomainEventOf, DomainEventType } from '@hajj/contracts/events/domainEvents'
import { setEventSink } from '../events/bus'
import { allOrganizationScopes } from '../security/organizations'
import { notifyBookingCancelled, notifyBookingConfirmed } from '../services/booking'
import { type EventHandle, handleEventOnce, pruneEventReceipts } from '../services/eventHandling'
import { defineJob, type JobDefinition } from './definition'
import { enqueue, JobRuntimeUnavailableError } from './runtime'

interface EventHandler<T extends DomainEventType> {
  event: T
  /** Stable, kebab-case: part of the queue name and of the receipt key. */
  name: string
  handle: EventHandle<DomainEventOf<T>>
}

/** One job per (event, handler), so every handler retries on its own; each runs at most once per event. */
function eventHandler<T extends DomainEventType>(handler: EventHandler<T>) {
  const key = `${handler.event}:${handler.name}`
  const job: JobDefinition<DomainEventOf<T>> = defineJob<DomainEventOf<T>>({
    name: `event.${handler.event}.${handler.name}`,
    tier: 'light',
    queue: { retryLimit: 5, retryDelay: 60, retryBackoff: true },
    handle: (event, { db }) => handleEventOnce(db, event, key, handler.handle),
  })
  return { ...handler, job }
}

/** Every handler of every domain event (Phase 2a ticket 7). */
export const EVENT_HANDLERS = [
  eventHandler({ event: 'booking.confirmed', name: 'notify-booker', handle: notifyBookingConfirmed }),
  eventHandler({ event: 'booking.cancelled', name: 'notify-booker', handle: notifyBookingCancelled }),
]

/** Daily: receipts older than any retry of their job are pruned (a re-delivery that late cannot happen). */
export const eventReceiptPruneJob = defineJob<Record<string, never>>({
  name: 'events.receipt-prune',
  tier: 'light',
  schedule: { cron: '45 3 * * *' },
  handle: async (_data, { db }) => {
    await pruneEventReceipts(db, await allOrganizationScopes(db), new Date())
  },
})

export const EVENT_JOBS = [...EVENT_HANDLERS.map(handler => handler.job), eventReceiptPruneJob]

/**
 * Wired when the job runtime is STARTED (before it is up: `enqueue` waits for the boot), in any mode that can
 * enqueue: a published event becomes one job per handler of its type, written in the publisher's transaction.
 * Duplicates are harmless (each handler claims its receipt). When the runtime is not running — it failed to start,
 * or the process is stopping — the event is logged and dropped: a side effect never blocks the change itself.
 */
export function wireDomainEvents(): void {
  setEventSink(async (tx, event) => {
    for (const handler of EVENT_HANDLERS.filter(h => h.event === event.type)) {
      try {
        // The filter above matched the handler's event type; the table's union type cannot say so.
        await enqueue(handler.job as JobDefinition<DomainEvent>, event, { tx })
      }
      catch (error) {
        if (!(error instanceof JobRuntimeUnavailableError)) throw error
        console.error(`[events] ${event.type} ${event.eventId} not handed to ${handler.name}: ${error.message}`)
      }
    }
  })
}
