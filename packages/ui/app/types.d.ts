import type { HookResult } from '@nuxt/schema'
import type { ApiError } from './utils/apiError'

declare module '#app' {
  interface RuntimeNuxtHooks {
    /** A call was answered "your session is over" (401 UNAUTHENTICATED / SESSION_INVALID): sign the visitor out. */
    'hajj:session-ended': () => HookResult
    /** A query or mutation failed (any error, as an `ApiError`): for an app's own reactions to particular codes. */
    'hajj:api-error': (error: ApiError) => HookResult
  }
}

export {}
