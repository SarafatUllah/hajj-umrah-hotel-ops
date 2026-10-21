import type { DocType } from '../../shared/constants/documents'
import type { HotelDocumentView } from '../repositories/hotel'

/** The API shape of a hotel document. The storage key is deliberately absent: it never leaves the server. */
export interface DocumentDto {
  id: string
  docType: DocType
  title: string
  description: string | null
  /** Sanitized display name — never a path. */
  originalFilename: string
  mimeType: string
  sizeBytes: number
  sha256: string
  uploadedBy: string | null
  createdAt: string
  archivedAt: string | null
}

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
