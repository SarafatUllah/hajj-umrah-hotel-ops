/** An agency's profile as its form holds it (v7 §6, §15): optional fields empty when not given. */
export interface AgencyProfileValues { name: string, licenseNo: string, contactName: string, phone: string, email: string, whatsappNumber: string, address: string }
/** An agency user's sign-in as its form holds it. */
export interface AgencyUserValues { fullName: string, email: string, password: string }

export const emptyAgencyProfile = (): AgencyProfileValues => ({ name: '', licenseNo: '', contactName: '', phone: '', email: '', whatsappNumber: '', address: '' })
export const emptyAgencyUser = (): AgencyUserValues => ({ fullName: '', email: '', password: '' })

/** The profile as the API takes it: an empty optional field is left out (never sent as ""). */
export function agencyProfileRequest(values: AgencyProfileValues) {
  return { ...values, whatsappNumber: values.whatsappNumber || undefined, address: values.address || undefined }
}
