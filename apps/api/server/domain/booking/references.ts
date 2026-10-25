import type { DocumentSequenceKind } from '@hajj/contracts/constants/booking'

const PREFIXES: Record<DocumentSequenceKind, string> = { QUOTE: 'Q', BOOKING: 'B' }

/** `Q-2027-0142`, `B-2027-0088`: the kind, the hotel's year and a per-organization counter (at least 4 digits). */
export function documentNo(kind: DocumentSequenceKind, year: number, sequence: number): string {
  return `${PREFIXES[kind]}-${year}-${String(sequence).padStart(4, '0')}`
}
