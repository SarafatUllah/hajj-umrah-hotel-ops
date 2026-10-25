/** A signed-in customer as the public site sees them. */
export interface CustomerMe { id: string, phone: string, fullName: string }

/** A code was texted (the same answer whether or not the phone has an account). */
export interface OtpChallengeIssued { challengeId: string, expiresInSeconds: number }

/** `POST /api/customer/auth/otp/verify`: signed in; `isNew` = the account was just created. */
export interface CustomerSignIn { customer: CustomerMe, isNew: boolean }
