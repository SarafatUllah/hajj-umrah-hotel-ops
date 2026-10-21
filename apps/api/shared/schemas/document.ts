import { z } from 'zod'
import { DOC_TYPES, MAX_DOCUMENT_DESCRIPTION_LENGTH, MAX_DOCUMENT_TITLE_LENGTH, MAX_DOCUMENTS_PER_PAGE } from '../constants/documents'
import { pagination, safeText } from './common'

// Free text where newlines and tabs are legitimate (a description), but no other control character.
// eslint-disable-next-line no-control-regex -- detecting C0 control characters (except \t \n \r) and DEL is the point.
const DISALLOWED_IN_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

const description = z.string()
  .transform(value => value.normalize('NFC').trim())
  .refine(value => !DISALLOWED_IN_MULTILINE.test(value), { message: 'Must not contain control characters' })
  .refine(value => value.length <= MAX_DOCUMENT_DESCRIPTION_LENGTH, { message: `Must be at most ${MAX_DOCUMENT_DESCRIPTION_LENGTH} characters` })

/**
 * The text fields of the upload's multipart form (`file` is the binary part and is not in this
 * schema). `.strict()`: an unknown field — `hotelId`, `organizationId`, `storageKey`, anything — is a
 * 422, never silently ignored. A blank description is stored as "no description".
 */
export const uploadDocumentFieldsSchema = z.object({
  docType: z.enum(DOC_TYPES),
  title: safeText(MAX_DOCUMENT_TITLE_LENGTH).refine(value => value.length > 0, { message: 'A title is required' }),
  description: description.optional().transform(value => (value && value.length > 0 ? value : null)),
}).strict()

export type UploadDocumentFields = z.infer<typeof uploadDocumentFieldsSchema>

const flag = z.enum(['true', 'false']).optional().transform(v => v === 'true')

/** `GET …/documents?includeArchived&page&pageSize` — `includeArchived` needs `hotel.manage` (403 otherwise). */
export const listDocumentsQuerySchema = z.object({
  includeArchived: flag,
  ...pagination({ maxPageSize: MAX_DOCUMENTS_PER_PAGE }).shape,
}).strict()

export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>

/** `GET …/documents/:documentId/download?includeArchived` — same flag, same rule. */
export const downloadDocumentQuerySchema = z.object({ includeArchived: flag }).strict()

export type DownloadDocumentQuery = z.infer<typeof downloadDocumentQuerySchema>
