import type { GuestSlotDto } from '@hajj/contracts/types/booking'

/** A pilgrim's passport fields as the forms hold them (the schema decides which are required). */
export interface GuestFieldValues {
  fullName: string
  gender?: 'MALE' | 'FEMALE'
  nationality?: string
  dateOfBirth?: string
  passportNo?: string
  passportExpiry?: string
}

/** Translates a message key with named arguments (`useI18n().t`). */
type Translate = (key: string, named?: Record<string, unknown>) => string

/** A pilgrim's place as people read it: "Place 3 · Adult", and in a group the side it sleeps on ("· Woman"). */
export function slotLabel(slot: Pick<GuestSlotDto, 'slotNo' | 'ageGroup' | 'gender'>, t: Translate): string {
  return [t('guest.place', { n: slot.slotNo }), t(`booking.ageGroup.${slot.ageGroup}`), slot.gender ? t(`booking.gender.${slot.gender}`) : ''].filter(Boolean).join(' · ')
}
