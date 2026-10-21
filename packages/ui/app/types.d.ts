import type { HookResult } from '@nuxt/schema'

declare module '#app' {
  interface RuntimeNuxtHooks {
    /** A call was answered "your session is over" (401 UNAUTHENTICATED / SESSION_INVALID): sign the visitor out. */
    'hajj:session-ended': () => HookResult
  }
}

export {}
