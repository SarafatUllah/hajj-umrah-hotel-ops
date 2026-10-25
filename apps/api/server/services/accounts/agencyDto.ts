import type { AgencyStatus } from '@hajj/contracts/constants/accounts'
import type { AgencyDto, AgencyUserDto } from '@hajj/contracts/types/agency'
import type { AgencyRow, AgencyUserRow } from '../../repositories/accounts'

export type { AgencyDto, AgencyUserDto }

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
