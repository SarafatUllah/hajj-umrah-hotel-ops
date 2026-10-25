/** Hotel document categories (Task 19). Mirrors the `hotel_document_type_check` constraint. */
export const DOC_TYPES = ['LICENSE', 'CONTRACT', 'INSURANCE', 'PERMIT', 'OTHER'] as const
export type DocType = typeof DOC_TYPES[number]

export const MAX_DOCUMENT_TITLE_LENGTH = 200
export const MAX_DOCUMENT_DESCRIPTION_LENGTH = 2000
/** What a hotel document may be: a PDF, or a PNG or JPEG image (the API also checks the bytes). */
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const

/**
 * Largest file any upload may carry (hotel documents, passport photos); the API refuses more, the frontends say so first
 * and shrink a larger photo to fit (utils/photos). 4 MB, with the form's framing, stays under the 4.5 MB a serverless
 * function accepts in one request (Vercel, D-P2-67); it was 10 MB.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024
/** Most documents one list page returns. */
export const MAX_DOCUMENTS_PER_PAGE = 100
