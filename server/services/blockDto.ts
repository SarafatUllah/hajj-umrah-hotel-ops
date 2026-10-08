import type { BlockKind } from '../../shared/constants/inventory'
import { type IsoDate, rangeLength } from '../../shared/utils/dates'
import { type BlockPhase, blockPhase, planBlockCancellation } from '../domain/inventory/blockRules'
import { InventoryRuleError } from '../domain/inventory/rules'
import type { BlockActor, RoomOperationalBlockView } from '../repositories/hotel'

export type { BlockPhase }

/**
 * S10/S11 block list item — the shape of the list, create and cancel responses. `phase` (display) and
 * `cancelAction` (which confirmation the UI offers) are computed here with the hotel's today; the UI
 * never compares dates to decide either. A block starting tonight is `phase: 'RUNNING'` yet
 * `cancelAction: 'CANCEL'` (the verified rule: start >= today -> full cancel).
 */
export interface BlockListItem {
  id: string
  room: { id: string, roomNumber: string }
  kind: BlockKind
  startDate: IsoDate
  /** The block's ACTUAL last night (after an early end, the shortened one; the plan is in `endedEarly.originalEndDate`). */
  endDate: IsoDate
  nights: number
  reason: string
  phase: BlockPhase
  cancelAction: 'CANCEL' | 'END_EARLY' | null
  createdBy: BlockActor | null
  createdAt: string
  /** Cancellation only — all three are `null` for a block that was ended early (that is reported under `endedEarly`). */
  cancelledAt: string | null
  cancelledBy: BlockActor | null
  cancelReason: string | null
  /** S11: visible to everyone who can see the block (not only `audit.view` holders). */
  endedEarly: { at: string, by: BlockActor | null, originalEndDate: IsoDate, reason: string } | null
}

/** `planBlockCancellation`'s answer as a value: `null` exactly when it would throw (already ended / already cancelled). */
function cancelActionOf(view: RoomOperationalBlockView, today: IsoDate): BlockListItem['cancelAction'] {
  try {
    return planBlockCancellation(view.block, today).kind
  }
  catch (error) {
    if (error instanceof InventoryRuleError) return null
    throw error
  }
}

export function toBlockListItem(view: RoomOperationalBlockView, today: IsoDate): BlockListItem {
  const b = view.block
  return {
    id: b.id,
    room: { id: b.roomId, roomNumber: view.roomNumber },
    kind: b.kind as BlockKind,
    startDate: b.startDate,
    endDate: b.endDate,
    nights: rangeLength({ from: b.startDate, to: b.endDate }),
    reason: b.reason,
    phase: blockPhase(b, today),
    cancelAction: cancelActionOf(view, today),
    createdBy: view.createdBy,
    createdAt: b.createdAt.toISOString(),
    cancelledAt: b.cancelledAt ? b.cancelledAt.toISOString() : null,
    cancelledBy: b.cancelledAt ? view.cancelledBy : null,
    cancelReason: b.cancelledAt ? b.cancelReason : null,
    endedEarly: b.endedEarlyAt && b.originalEndDate
      ? { at: b.endedEarlyAt.toISOString(), by: view.endedEarlyBy, originalEndDate: b.originalEndDate, reason: b.cancelReason ?? '' }
      : null,
  }
}
