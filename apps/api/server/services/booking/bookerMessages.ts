import { composeEmail, isEmailEnabled, useEmailSender } from '../../notifications/email'
import { isSmsEnabled, useSmsSender } from '../../notifications/sms'
import type { OrganizationScope } from '../../security/scope'
import { findBookerContact, type BookerRef } from '../accounts'

type Db = Parameters<typeof findBookerContact>[0]

/** A short message to a booker: the text (a text message, or the e-mail's body) and the e-mail's subject. */
export interface BookerMessage { subject: string, text: string }

/** How it went: sent; nobody to send it to (a closed account); or the booker's channel is not configured (skipped, logged). */
export type BookerDelivery = 'sent' | 'no-contact' | 'channel-off'

/** Whether any channel to bookers is configured (a job with nothing it could send skips its work). */
export function canMessageBookers(): boolean {
  return isSmsEnabled() || isEmailEnabled()
}

function skipped(bookingNo: string, channel: string): BookerDelivery {
  console.info(`[booker-message] booking ${bookingNo}: not sent, ${channel} is not configured`)
  return 'channel-off'
}

/**
 * Sends a booker a message on the one channel they are reached on (D-P2-68): a text message when they have a phone
 * (every agency, and a customer who signs in with one), else an e-mail to a customer's verified address. A channel
 * that is not configured skips the message with a log line naming the booking only; a failed send throws.
 */
export async function messageBooker(db: Db, scope: OrganizationScope, booker: BookerRef & { bookingNo: string }, message: BookerMessage): Promise<BookerDelivery> {
  const contact = await findBookerContact(db, scope, booker)
  if (contact.phone) {
    if (!isSmsEnabled()) return skipped(booker.bookingNo, 'SMS_DRIVER')
    await useSmsSender().send({ to: contact.phone, text: message.text })
    return 'sent'
  }
  if (contact.email) {
    if (!isEmailEnabled()) return skipped(booker.bookingNo, 'EMAIL_DRIVER')
    await useEmailSender().send(composeEmail(contact.email, message.subject, [message.text]))
    return 'sent'
  }
  return 'no-contact'
}
