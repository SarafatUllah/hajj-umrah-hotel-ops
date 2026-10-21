import type { CustomerMe } from '@hajj/contracts/types/customer'

/**
 * The signed-in customer (undefined = not asked yet, null = signed out), shared by the header and the guarded pages;
 * the server is asked once per visit and after every sign-in or sign-out.
 */
export function useCustomerSession() {
  const customer = useState<CustomerMe | null | undefined>('customer', () => undefined)
  const api = useApi()
  const { $queryClient } = useNuxtApp()

  async function refresh(): Promise<CustomerMe | null> {
    try {
      customer.value = await api<CustomerMe>('/customer/auth/me')
    }
    catch (error) {
      if (toApiError(error).status !== 401) throw error
      customer.value = null
    }
    return customer.value
  }

  async function signOut(everywhere = false): Promise<void> {
    await api(everywhere ? '/customer/auth/logout-all' : '/customer/auth/logout', { method: 'POST' })
    customer.value = null
    $queryClient.clear()
  }

  return {
    customer,
    refresh,
    ensure: () => (customer.value === undefined ? refresh() : Promise.resolve(customer.value)),
    signOut,
  }
}
