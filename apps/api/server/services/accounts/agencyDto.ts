import type { AgencyStatus } from '@hajj/contracts/constants/accounts'
import type { AgencyRow, AgencyUserRow } from '../../repositories/accounts'

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

export function toAgencyDto(row: AgencyRow): AgencyDto {
  return {
    id: row.id,
    name: row.name,
    licenseNo: row.licenseNo,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    whatsappNumber: row.whatsappNumber,
    address: row.address,
    status: row.status as AgencyStatus,
    statusReason: row.statusReason,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export function toAgencyUserDto(row: AgencyUserRow): AgencyUserDto {
  return {
    id: row.id,
    agencyId: row.agencyId,
    email: row.email,
    fullName: row.fullName,
    phone: row.phone,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}
