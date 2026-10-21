/** The agency API's response shapes (v7 §6, §15). */
import type { AgencyStatus } from '../constants/accounts'

export interface AgencyDto {
  id: string
  name: string
  licenseNo: string
  contactName: string
  phone: string
  email: string
  whatsappNumber: string | null
  address: string | null
  status: AgencyStatus
  statusReason: string | null
  approvedAt: string | null
  createdAt: string
}

/** Never carries the password hash or the session version. */
export interface AgencyUserDto {
  id: string
  agencyId: string
  email: string
  fullName: string
  phone: string | null
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
}

/** The signed-in agency user and their agency (never the staff's internal `statusReason`). */
export interface AgencyMe { user: Omit<AgencyUserDto, 'isActive' | 'lastLoginAt' | 'createdAt' | 'phone'>, agency: Pick<AgencyDto, 'id' | 'name' | 'status'> }
