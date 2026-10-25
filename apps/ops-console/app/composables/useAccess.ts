import { accessOf } from '../utils/access'

/** What the signed-in staff member may do, kept in step with the session (§34: display only, the API decides). */
export function useAccess() {
  const { me } = useStaffSession()
  return computed(() => accessOf(me.value))
}
