import type { AgencyMe } from '@hajj/contracts/types/agency'

/** The signed-in agency user and their agency (the layer's principal session, typed for the portal). */
export function useAgencySession() {
  const session = usePrincipalSession<AgencyMe>()
  return { ...session, me: session.current }
}
