import type { BlockKind } from '@hajj/contracts/constants/inventory'
import { type IsoDate, rangeLength } from '@hajj/contracts/utils/dates'
import { type BlockPhase, blockPhase, planBlockCancellation } from '../domain/inventory/blockRules'
import { InventoryRuleError } from '../domain/inventory/rules'
import type { RoomOperationalBlockView } from '../repositories/hotel'
import type { BlockListItem } from '@hajj/contracts/types/rooms'

export type { BlockListItem }

export type { BlockPhase }

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
