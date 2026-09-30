/**
 * Raised by the pure inventory rule modules. Services translate it: kind 'conflict' -> HTTP 409,
 * kind 'validation' -> HTTP 422. (The domain layer must not import server/errors.)
 */
export class InventoryRuleError extends Error {
  constructor(readonly code: string, message: string, readonly kind: 'conflict' | 'validation' = 'conflict') {
    super(message)
    this.name = 'InventoryRuleError'
  }
}
