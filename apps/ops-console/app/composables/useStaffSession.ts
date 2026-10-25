import type { StaffMe } from '@hajj/contracts/types/staff'

/** The signed-in staff member (the layer's principal session, typed for the console). */
export function useStaffSession() {
  const session = usePrincipalSession<StaffMe>()
  return { ...session, me: session.current }
}
