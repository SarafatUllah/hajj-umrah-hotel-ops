<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { agencyLoginSchema } from '@hajj/contracts/schemas/agency'

definePageMeta({ middleware: 'guest' })
const { t } = useI18n()
const route = useRoute()
const api = useApi()
const errorMessage = useErrorMessage()
const session = useAgencySession()
const organizationSlug = useRuntimeConfig().public.organizationSlug
useSeoMeta({ title: () => t('login.title') })

const form = ref({ email: '', password: '' })
const validate = validateWith(agencyLoginSchema, key => t(key), (state: typeof form.value) => ({ organizationSlug, ...state }))
const signIn = useMutation({
  mutationFn: async () => {
    await api('/agency/auth/login', { method: 'POST', body: { organizationSlug, ...form.value } })
    return session.refresh()
  },
  onSuccess: async (me) => {
    if (me) session.signedIn(me)
    await navigateTo(safeRedirect(route.query.redirect, '/'))
  },
})
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6">
    <PageHeader :title="t('login.title')" />
    <UForm :state="form" :validate="validate" class="surface-panel flex flex-col gap-4 p-6" @submit="signIn.mutate()">
      <UFormField :label="t('login.email')" name="email" required>
        <UInput v-model="form.email" type="email" autocomplete="username" dir="ltr" class="w-full" />
      </UFormField>
      <UFormField :label="t('login.password')" name="password" required>
        <UInput v-model="form.password" type="password" autocomplete="current-password" class="w-full" />
      </UFormField>
      <UAlert v-if="signIn.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(signIn.error.value)" role="alert" />
      <UButton type="submit" :loading="signIn.isPending.value" class="self-start">{{ t('login.submit') }}</UButton>
    </UForm>
    <UButton to="/register" color="neutral" variant="link" class="self-start">{{ t('login.newAgency') }}</UButton>
  </div>
</template>
