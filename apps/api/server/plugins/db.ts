import { stopJobRuntime } from '../jobs/runtime'
import { closeDb } from '../utils/db'

// Closes the shared DB connection pool when Nitro shuts down, so the
// process can exit cleanly instead of hanging on open sockets. Close hooks run
// in plugin order and this plugin comes first: the job runtime stops before the
// pool its in-flight handlers use goes away (stopJobRuntime is idempotent).
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', async () => {
    await stopJobRuntime()
    await closeDb()
  })
})
