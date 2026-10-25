import type { DocType } from '@hajj/contracts/constants/documents'
import type { HotelDocumentView } from '../repositories/hotel'
import type { DocumentDto } from '@hajj/contracts/types/hotel'

export type { DocumentDto }

export function toDocumentDto(view: HotelDocumentView): DocumentDto {
  const { document, asset } = view
  return {
    id: document.documentId,
    docType: document.docType as DocType,
    title: document.title,
    description: document.description,
    originalFilename: asset.originalFilename,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    uploadedBy: asset.uploadedBy,
    createdAt: asset.createdAt.toISOString(),
    archivedAt: asset.archivedAt ? asset.archivedAt.toISOString() : null,
  }
}
