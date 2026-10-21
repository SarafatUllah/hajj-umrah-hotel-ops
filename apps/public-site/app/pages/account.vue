<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import type { CustomerSignIn } from '@hajj/contracts/types/customer'

definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const toast = useToast()
const errorMessage = useErrorMessage()
const { customer, signOut } = useCustomerSession()
const { $queryClient } = useNuxtApp()
useSeoMeta({ title: () => t('account.title'), robots: 'noindex' })

const signOutEverywhere = useMutation({
  mutationFn: () => signOut(true),
  onSuccess: () => navigateTo('/'),
  onError: error => toast.add({ title: errorMessage(error), color: 'error', icon: 'i-lucide-triangle-alert' }),
})

// Closing is irreversible (tier 2) and needs a fresh code (D-P2-27b): a STEP_UP_REQUIRED answer asks for one, then retries.
const closeOpen = ref(false)
const stepUp = ref(false)
const close = useMutation({
  mutationFn: () => api('/customer/account/close', { method: 'POST' }),
  onSuccess: async () => {
    closeOpen.value = false
    customer.value = null
    $queryClient.clear()
    toast.add({ title: t('account.closed'), color: 'success', icon: 'i-lucide-circle-check' })
    await navigateTo('/')
  },
  onError: (error) => {
    closeOpen.value = false
    if (toApiError(error).code === 'STEP_UP_REQUIRED') stepUp.value = true
  },
})
function confirmedWithCode(result: CustomerSignIn) {
  customer.value = result.customer
  stepUp.value = false
  close.mutate()
}
</script>

<template>
  <div v-if="customer" class="mx-auto flex max-w-xl flex-col gap-6">
    <PageHeader :title="t('account.title')" />
    <dl class="surface-panel grid gap-4 p-5">
      <div>
        <dt class="text-caption text-(--fg-muted)">{{ t('account.name') }}</dt>
        <dd><bdi>{{ customer.fullName }}</bdi></dd>
      </div>
      <div>
        <dt class="text-caption text-(--fg-muted)">{{ t('account.phone') }}</dt>
        <dd class="tabular" dir="ltr">{{ customer.phone }}</dd>
      </div>
    </dl>
    <div class="flex flex-wrap gap-2">
      <UButton color="neutral" variant="outline" icon="i-lucide-log-out" :loading="signOutEverywhere.isPending.value" @click="signOutEverywhere.mutate()">{{ t('account.signOutEverywhere') }}</UButton>
    </div>

    <section aria-labelledby="close-heading" class="flex flex-col gap-3 border-t border-(--border) pt-6">
      <h2 id="close-heading" class="text-section">{{ t('account.close') }}</h2>
      <p class="text-(--fg-muted)">{{ t('account.closeText') }}</p>
      <UAlert v-if="close.error.value && !stepUp" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(close.error.value)" role="alert" />
      <div v-if="stepUp" class="surface-panel flex flex-col gap-4 p-5">
        <p>{{ t('account.stepUp') }}</p>
        <PhoneCodeForm :fixed-phone="customer.phone" :submit-label="t('account.close')" @signed-in="confirmedWithCode" />
        <UButton color="neutral" variant="ghost" class="self-start" @click="stepUp = false">{{ t('common.cancel') }}</UButton>
      </div>
      <UButton v-else color="error" variant="outline" icon="i-lucide-user-x" class="self-start" @click="closeOpen = true">{{ t('account.close') }}</UButton>
    </section>

    <ConfirmDialog
      v-model:open="closeOpen"
      :title="t('account.closeTitle')"
      :description="t('account.closeText')"
      :confirm-label="t('account.close')"
      :tier="2"
      :pending="close.isPending.value"
      destructive
      @confirm="close.mutate()"
    />
  </div>
</template>
