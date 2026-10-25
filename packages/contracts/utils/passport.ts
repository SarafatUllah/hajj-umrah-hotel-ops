/** How a passport number shows to whoever may not read it in full (v7 §13: lists, the calendar, the desk). */
const MASK = '•••'

/** Its last three characters only (two of a short one). */
export const maskPassport = (passportNo: string): string => `${MASK}${passportNo.slice(passportNo.length >= 8 ? -3 : -2)}`

/** A number shown masked: what is on screen is not the number, so it can be neither corrected nor sent back. */
export const isMaskedPassport = (value: string | null | undefined): boolean => !!value?.startsWith(MASK)
