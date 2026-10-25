import { getStorageDriver } from '../storage'

// Task 19: fail at startup — not on the first upload — when the storage configuration is invalid
// (e.g. an unsupported STORAGE_DRIVER). getStorageEnv() validates only the storage settings (so this
// check does not change how a missing DATABASE_URL behaves) and createStorageDriver refuses an unknown
// driver; there is no fallback to local disk.
export default defineNitroPlugin(() => {
  getStorageDriver()
})
