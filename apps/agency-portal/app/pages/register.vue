<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { agencyRegistrationSchema } from '@hajj/contracts/schemas/agency'

definePageMeta({ middleware: 'guest' })
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const organizationSlug = useRuntimeConfig().public.organizationSlug
useSeoMeta({ title: () => t('register.title') })

const form = ref({ agency: emptyAgencyProfile(), user: emptyAgencyUser() })
const toRequest = (state: typeof form.value) => ({ organizationSlug, agency: agencyProfileRequest(state.agency), user: state.user })
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
        <AgencyProfileFields v-model="form.agency" prefix="agency." />
      </fieldset>
      <fieldset class="flex flex-col gap-4">
        <legend class="text-subsection">{{ t('register.user') }}</legend>
        <AgencyUserFields v-model="form.user" prefix="user." own />
      </fieldset>
      <UAlert v-if="register.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(register.error.value)" role="alert" />
      <UButton type="submit" :loading="register.isPending.value" class="self-start">{{ t('register.submit') }}</UButton>
    </UForm>
  </div>
</template>
