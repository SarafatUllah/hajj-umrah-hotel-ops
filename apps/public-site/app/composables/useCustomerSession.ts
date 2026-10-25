import type { CustomerMe } from '@hajj/contracts/types/customer'

/** The signed-in customer (the layer's principal session, typed for this site). */
export function useCustomerSession() {
  const session = usePrincipalSession<CustomerMe>()
  return { ...session, customer: session.current }
}
