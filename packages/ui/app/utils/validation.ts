import type { ZodIssue, ZodType, ZodTypeDef } from 'zod'

/** A field problem as Nuxt UI's `UForm` shows it under the field (`name` = the path, dotted). */
export interface FieldError { name: string, message: string }

const isEmpty = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

/**
 * The localized message key of a Zod issue (the shared schemas' own English messages are not shown to people). Any
 * issue on an empty value means the field is required, whatever rule caught it.
 */
export function validationKey(issue: ZodIssue, value?: unknown): string {
  if (isEmpty(value)) return 'validation.required'
  switch (issue.code) {
    case 'invalid_type': return issue.received === 'undefined' || issue.received === 'null' ? 'validation.required' : 'validation.invalid'
    case 'too_small': return issue.type === 'string' || issue.type === 'array' ? (issue.minimum === 1 ? 'validation.required' : 'validation.tooShort') : 'validation.tooSmall'
    case 'too_big': return issue.type === 'string' || issue.type === 'array' ? 'validation.tooLong' : 'validation.tooBig'
    case 'invalid_date': return 'validation.date'
    default: return 'validation.invalid'
  }
}

/**
 * Validates a form with a shared Zod schema (§17: the same schemas as the API), the form's values first turned into
 * the request (`toRequest`). Returns the field errors, localized by `translate`.
 */
export function validateWith<S, R>(schema: ZodType<R, ZodTypeDef, unknown>, translate: (key: string) => string, toRequest: (state: S) => unknown = state => state) {
  return (state: S): FieldError[] => {
    const request = toRequest(state)
    const result = schema.safeParse(request)
    if (result.success) return []
    return result.error.issues.map(issue => ({ name: issue.path.join('.'), message: translate(validationKey(issue, valueAt(request, issue.path))) }))
  }
}

/** The value at a path of the request (for "required" versus "invalid"). */
function valueAt(request: unknown, path: ReadonlyArray<string | number>): unknown {
  return path.reduce<unknown>((node, key) => (node !== null && typeof node === 'object' ? (node as Record<string | number, unknown>)[key] : undefined), request)
}
