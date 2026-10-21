<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { agencyPasswordChangeSchema } from '@hajj/contracts/schemas/agency'

/**
 * The signed-in agency user's account (D-P2-25b): who they are, and a new password — proven by the current one;
 * every other session of theirs then ends (this one goes on). Open whatever the agency's status.
 */
definePageMeta({ middleware: 'auth' })
const { t } = useI18n()
const api = useApi()
const toast = useToast()
const errorMessage = useErrorMessage()
const { me } = useAgencySession()
useSeoMeta({ title: () => t('account.title') })

const blank = () => ({ currentPassword: '', newPassword: '' })
const form = ref(blank())
const validate = validateWith(agencyPasswordChangeSchema, key => t(key))
const change = useMutation({
  mutationFn: () => api<{ success: true }>('/agency/auth/password', { method: 'POST', body: form.value }),
  onSuccess: () => {
    form.value = blank()
    toast.add({ title: t('account.passwordChanged'), color: 'success', icon: 'i-lucide-circle-check' })
  },
})
</script>

<template>
  <div class="mx-auto flex max-w-xl flex-col gap-6">
    <h1 class="text-page-title">{{ t('account.title') }}</h1>
    <dl v-if="me" class="surface-panel grid gap-3 p-6 text-small sm:grid-cols-2">
      <div><dt class="text-caption text-(--fg-muted)">{{ t('agencyForm.fullName') }}</dt><dd><bdi>{{ me.user.fullName }}</bdi></dd></div>
      <div><dt class="text-caption text-(--fg-muted)">{{ t('agencyForm.email') }}</dt><dd dir="ltr" class="text-start">{{ me.user.email }}</dd></div>
      <div class="sm:col-span-2"><dt class="text-caption text-(--fg-muted)">{{ t('account.agency') }}</dt><dd><bdi>{{ me.agency.name }}</bdi></dd></div>
    </dl>
    <section aria-labelledby="password-heading" class="surface-panel flex flex-col gap-4 p-6">
      <h2 id="password-heading" class="text-section">{{ t('account.password') }}</h2>
      <p class="text-small text-(--fg-muted)">{{ t('account.passwordHelp') }}</p>
      <UForm :state="form" :validate="validate" class="flex flex-col gap-4" @submit="change.mutate()">
        <UFormField :label="t('account.currentPassword')" name="currentPassword" required>
          <UInput v-model="form.currentPassword" type="password" autocomplete="current-password" class="w-full" />
        </UFormField>
        <UFormField :label="t('account.newPassword')" :help="t('agencyForm.passwordHelp')" name="newPassword" required>
          <UInput v-model="form.newPassword" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UAlert v-if="change.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(change.error.value)" role="alert" />
        <UButton type="submit" :loading="change.isPending.value" class="self-start">{{ t('account.changePassword') }}</UButton>
      </UForm>
    </section>
  </div>
</template>
