<script setup lang="ts">
import type { CustomerSignIn } from '@hajj/contracts/types/customer'

definePageMeta({ middleware: 'guest' })
const { t } = useI18n()
const route = useRoute()
const { customer } = useCustomerSession()
const { $queryClient } = useNuxtApp()
useSeoMeta({ title: () => t('signIn.title'), robots: 'noindex' })

async function signedIn(result: CustomerSignIn) {
  // Nothing cached for a previous visitor of this browser shows to the one signing in.
  $queryClient.clear()
  customer.value = result.customer
  await navigateTo(safeRedirect(route.query.redirect))
}
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6">
    <PageHeader :title="t('signIn.title')" :description="t('signIn.lead')" />
    <div class="surface-panel p-6">
      <PhoneCodeForm @signed-in="signedIn" />
    </div>
  </div>
</template>
