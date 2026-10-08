/** Hotel document categories (Task 19). Mirrors the `hotel_document_type_check` constraint. */
export const DOC_TYPES = ['LICENSE', 'CONTRACT', 'INSURANCE', 'PERMIT', 'OTHER'] as const
export type DocType = typeof DOC_TYPES[number]

export const MAX_DOCUMENT_TITLE_LENGTH = 200
export const MAX_DOCUMENT_DESCRIPTION_LENGTH = 2000
/** Most documents one list page returns. */
export const MAX_DOCUMENTS_PER_PAGE = 100
