import { toApiError } from '../utils/apiError'

/**
 * A failed call as a sentence for people (§20.3): the error code's own translation (named arguments from `details`),
 * else by status — never the server's raw text.
 */
export function useErrorMessage() {
  const { t, te } = useI18n()
  return (error: unknown): string => {
    const apiError = toApiError(error)
    if (apiError.code === 'NETWORK') return t('errors.network')
    const key = `errors.codes.${apiError.code}`
    if (te(key)) return t(key, messageArgs(apiError.details))
    if (apiError.status === 401) return t('errors.unauthenticated')
    if (apiError.status === 403) return t('errors.forbidden')
    if (apiError.status === 404) return t('errors.notFound')
    if (apiError.status === 429) return t('errors.tooManyRequests')
    if (apiError.status >= 500) return t('errors.server')
    return t('errors.unknown')
  }
}

/** The named arguments a message may use: scalar details as they are, lists joined. */
function messageArgs(details: unknown): Record<string, string | number> {
  if (!details || typeof details !== 'object') return {}
  return Object.fromEntries(Object.entries(details).flatMap(([name, value]): Array<[string, string | number]> => {
    if (typeof value === 'string' || typeof value === 'number') return [[name, value]]
    if (Array.isArray(value) && value.every(v => typeof v === 'string' || typeof v === 'number')) return [[name, value.join(', ')]]
    return []
  }))
}
