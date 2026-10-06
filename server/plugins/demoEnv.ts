import { getDemoEnv } from '../utils/env'

// Task 20: fail at startup when the demo settings are invalid — in particular DEMO_SIGN_IN_ENABLED=true
// under production — instead of silently serving (or silently hiding) demo credentials. Staging with the
// flag on starts normally; the runtime gate (isDemoSignInEnabled) keeps the endpoint closed there. Validates
// only the demo settings, so it does not change how a missing DATABASE_URL behaves (same approach as the
// storage plugin).
export default defineNitroPlugin(() => {
  getDemoEnv()
})
