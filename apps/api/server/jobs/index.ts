import type { JobDefinition } from './definition'

/**
 * Every job the application knows about. Modules register their jobs here as they land (hold sweep,
 * reminders, passport OCR, retention). Order is irrelevant.
 */
export const JOBS: readonly JobDefinition<never>[] = []
