import type { IsoDate } from '@hajj/contracts/utils/dates'

/** An agency quota row (v7 §10): `agencyId` null = the default for every agency; seasons are inclusive nights. */
export interface QuotaRow { agencyId: string | null, startDate: IsoDate, endDate: IsoDate, maxPersons: number }

/** The quota on one night: the agency's own row, else the default row, else none (§23 Q19). */
export function quotaOn(rows: readonly QuotaRow[], agencyId: string, night: IsoDate): number | null {
  const covers = (row: QuotaRow) => row.startDate <= night && night <= row.endDate
  return (rows.find(r => r.agencyId === agencyId && covers(r)) ?? rows.find(r => r.agencyId === null && covers(r)))?.maxPersons ?? null
}

/**
 * v7 §9.2 step 1: how many more persons the agency may hold on every night of the stay — the smallest
 * (quota − persons already held, HELD and extra beds included) over the nights that have a quota; null = no
 * limit on any night. Infants never count (the caller's `heldByNight` and new count exclude them).
 */
export function quotaHeadroom(args: { agencyId: string, nights: readonly IsoDate[], rows: readonly QuotaRow[], heldByNight: ReadonlyMap<IsoDate, number> }): number | null {
  let headroom: number | null = null
  for (const night of args.nights) {
    const quota = quotaOn(args.rows, args.agencyId, night)
    if (quota === null) continue
    const left = Math.max(0, quota - (args.heldByNight.get(night) ?? 0))
    headroom = headroom === null ? left : Math.min(headroom, left)
  }
  return headroom
}
