import { emailAddress } from '@hajj/contracts/schemas/common'
import type { CustomerMe } from '@hajj/contracts/types/customer'

/** How a customer gets a sign-in code (D-P2-68): by e-mail (first: pilgrims book from anywhere) or by text message. */
export const SIGN_IN_METHODS = ['email', 'phone'] as const
export type SignInMethod = typeof SIGN_IN_METHODS[number]

/** Where a code goes: an e-mail address or a phone number. */
export interface SignInDestination { method: SignInMethod, value: string }

/** Whether the shared schema takes this address (spaces around it and capitals are fine: the API normalizes). */
export function isEmailAddress(value: string): boolean {
  return emailAddress.safeParse(value).success
}

/** The code request: the chosen destination only (the API takes a phone or an e-mail, never both), and the bot check's token. */
export function codeRequestBody(organizationSlug: string, destination: SignInDestination, captchaToken: string | null): Record<string, string> {
  return { organizationSlug, [destination.method]: destination.value.trim(), ...(captchaToken ? { captchaToken } : {}) }
}

/** Where a signed-in customer confirms with a new code (D-P2-27b): their own phone, else their own address. */
export function ownDestination(customer: Pick<CustomerMe, 'phone' | 'email'>): SignInDestination | undefined {
  if (customer.phone) return { method: 'phone', value: customer.phone }
  if (customer.email) return { method: 'email', value: customer.email }
  return undefined
}
