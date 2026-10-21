/** A pilgrim's passport fields as the forms hold them (the schema decides which are required). */
export interface GuestFieldValues {
  fullName: string
  gender?: 'MALE' | 'FEMALE'
  nationality?: string
  dateOfBirth?: string
  passportNo?: string
  passportExpiry?: string
}
