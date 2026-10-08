import { closeDb } from '../utils/db'

// Closes the shared DB connection pool when Nitro shuts down, so the
// process can exit cleanly instead of hanging on open sockets.
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', closeDb)
})
