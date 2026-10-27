import { composeEmail, isEmailEnabled, useEmailSender } from '../../notifications/email'
import { isSmsEnabled, useSmsSender } from '../../notifications/sms'
import type { OrganizationScope } from '../../security/scope'
import { findBookerContact, type BookerRef } from '../accounts'

type Db = Parameters<typeof findBookerContact>[0]

/** A short message to a booker: the text (a text message, or the e-mail's body) and the e-mail's subject. */
export interface BookerMessage { subject: string, text: string }

/** The setting that keeps a booker's channel off: their messages wait until it is configured. */
export type BookerChannelSetting = 'SMS_DRIVER' | 'EMAIL_DRIVER'

/** How it went: sent; nobody to send it to (a closed account); or not sent, the booker's channel being off. */
export type BookerDelivery = 'sent' | 'no-contact' | { channelOff: BookerChannelSetting }

/** Whether any channel to bookers is configured (a job with nothing it could send skips its work). */
export function canMessageBookers(): boolean {
  return isSmsEnabled() || isEmailEnabled()
}

/**
 * Sends a booker a message on the one channel they are reached on (D-P2-68): a text message when they have a phone
 * (every agency, and a customer who signs in with one), else an e-mail to a customer's verified address. A channel
 * that is not configured sends nothing and says which setting is off (the caller logs it); a failed send throws.
 */
export async function messageBooker(db: Db, scope: OrganizationScope, booker: BookerRef, message: BookerMessage): Promise<BookerDelivery> {
  const contact = await findBookerContact(db, scope, booker)
  if (contact.phone) {
    if (!isSmsEnabled()) return { channelOff: 'SMS_DRIVER' }
    await useSmsSender().send({ to: contact.phone, text: message.text })
    return 'sent'
  }
  if (contact.email) {
    if (!isEmailEnabled()) return { channelOff: 'EMAIL_DRIVER' }
    await useEmailSender().send(composeEmail(contact.email, message.subject, [message.text]))
    return 'sent'
  }
  return 'no-contact'
}
