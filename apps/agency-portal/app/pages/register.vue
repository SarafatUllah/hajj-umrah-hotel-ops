<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { agencyRegistrationSchema } from '@hajj/contracts/schemas/agency'

definePageMeta({ middleware: 'guest' })
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const organizationSlug = useRuntimeConfig().public.organizationSlug
useSeoMeta({ title: () => t('register.title') })

const form = ref({
  agency: { name: '', licenseNo: '', contactName: '', phone: '', email: '', whatsappNumber: '', address: '' },
  user: { fullName: '', email: '', password: '' },
})
/** The request: empty optional fields are left out. */
const toRequest = (state: typeof form.value) => ({
  organizationSlug,
  agency: { ...state.agency, whatsappNumber: state.agency.whatsappNumber || undefined, address: state.agency.address || undefined },
  user: state.user,
})
const validate = validateWith(agencyRegistrationSchema, key => t(key), toRequest)
const register = useMutation({ mutationFn: () => api('/agency/register', { method: 'POST', body: toRequest(form.value) }) })
</script>

<template>
  <div class="mx-auto flex max-w-2xl flex-col gap-6">
    <PageHeader :title="t('register.title')" :description="t('register.lead')" />
    <div v-if="register.isSuccess.value" class="surface-panel flex flex-col gap-4 p-6" role="status">
      <p>{{ t('register.received') }}</p>
      <UButton to="/login" class="self-start">{{ t('register.toLogin') }}</UButton>
    </div>
    <UForm v-else :state="form" :validate="validate" class="surface-panel flex flex-col gap-6 p-6" @submit="register.mutate()">
      <fieldset class="flex flex-col gap-4">
        <legend class="text-subsection">{{ t('register.agency') }}</legend>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField :label="t('register.name')" name="agency.name" required><UInput v-model="form.agency.name" class="w-full" /></UFormField>
          <UFormField :label="t('register.licenseNo')" name="agency.licenseNo" required><UInput v-model="form.agency.licenseNo" dir="ltr" class="w-full" /></UFormField>
          <UFormField :label="t('register.contactName')" name="agency.contactName" required><UInput v-model="form.agency.contactName" class="w-full" /></UFormField>
          <UFormField :label="t('register.phone')" name="agency.phone" required><UInput v-model="form.agency.phone" type="tel" dir="ltr" class="w-full" /></UFormField>
          <UFormField :label="t('register.agencyEmail')" name="agency.email" required><UInput v-model="form.agency.email" type="email" dir="ltr" class="w-full" /></UFormField>
          <UFormField :label="t('register.whatsapp')" name="agency.whatsappNumber"><UInput v-model="form.agency.whatsappNumber" type="tel" dir="ltr" class="w-full" /></UFormField>
          <UFormField :label="t('register.address')" name="agency.address" class="sm:col-span-2"><UInput v-model="form.agency.address" class="w-full" /></UFormField>
        </div>
      </fieldset>
      <fieldset class="flex flex-col gap-4">
        <legend class="text-subsection">{{ t('register.user') }}</legend>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField :label="t('register.fullName')" name="user.fullName" required><UInput v-model="form.user.fullName" autocomplete="name" class="w-full" /></UFormField>
          <UFormField :label="t('register.email')" name="user.email" required><UInput v-model="form.user.email" type="email" autocomplete="username" dir="ltr" class="w-full" /></UFormField>
          <UFormField :label="t('register.password')" :help="t('register.passwordHelp')" name="user.password" required><UInput v-model="form.user.password" type="password" autocomplete="new-password" class="w-full" /></UFormField>
        </div>
      </fieldset>
      <UAlert v-if="register.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(register.error.value)" role="alert" />
      <UButton type="submit" :loading="register.isPending.value" class="self-start">{{ t('register.submit') }}</UButton>
    </UForm>
  </div>
</template>
