<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { createAgencySchema } from '@hajj/contracts/schemas/agency'
import type { AgencyDetail } from '@hajj/contracts/types/agency'
import { heldWhile } from '../../utils/forms'

/** An agency the staff checked offline (v7 §15): its profile and its first sign-in; it is approved at once. */
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [AgencyDetail] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const form = ref({ agency: emptyAgencyProfile(), user: emptyAgencyUser() })
const request = (state: typeof form.value) => ({ agency: agencyProfileRequest(state.agency), user: state.user })
const validate = validateWith(createAgencySchema, key => t(key), request)
const create = useMutation({
  mutationFn: () => api<AgencyDetail>('/agencies', { method: 'POST', body: request(form.value) }),
  onSuccess: (agency) => {
    open.value = false
    emit('created', agency)
  },
})
watch(open, (isOpen) => {
  if (!isOpen) return
  form.value = { agency: emptyAgencyProfile(), user: emptyAgencyUser() }
  create.reset()
})
</script>

<template>
  <USlideover v-bind="heldWhile(create.isPending.value)" v-model:open="open" :title="t('agencies.new')" :description="t('agencies.newHelp')" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <UForm :state="form" :validate="validate" class="flex flex-col gap-6" @submit="create.mutate()">
        <fieldset class="flex flex-col gap-4">
          <legend class="text-subsection">{{ t('agencies.profile') }}</legend>
          <AgencyProfileFields v-model="form.agency" prefix="agency." />
        </fieldset>
        <fieldset class="flex flex-col gap-4">
          <legend class="text-subsection">{{ t('agencies.firstUser') }}</legend>
          <AgencyUserFields v-model="form.user" prefix="user." />
        </fieldset>
        <UAlert v-if="create.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(create.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="create.isPending.value">{{ t('agencies.create') }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="create.isPending.value" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
