<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { createAgencyUserSchema } from '@hajj/contracts/schemas/agency'
import type { AgencyUserDto } from '@hajj/contracts/types/agency'
import { heldWhile } from '../../utils/forms'

/** Another sign-in for an agency's portal: name, email and a first password, given to the agency. */
const props = defineProps<{ agencyId: string }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ added: [AgencyUserDto] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const form = ref(emptyAgencyUser())
const validate = validateWith(createAgencyUserSchema, key => t(key))
const add = useMutation({
  mutationFn: () => api<AgencyUserDto>(`/agencies/${props.agencyId}/users`, { method: 'POST', body: form.value }),
  onSuccess: (user) => {
    open.value = false
    emit('added', user)
  },
})
watch(open, (isOpen) => {
  if (!isOpen) return
  form.value = emptyAgencyUser()
  add.reset()
})
</script>

<template>
  <USlideover v-bind="heldWhile(add.isPending.value)" v-model:open="open" :title="t('agencies.addUser')" :description="t('agencies.addUserHelp')">
    <template #body>
      <UForm :state="form" :validate="validate" class="flex flex-col gap-4" @submit="add.mutate()">
        <AgencyUserFields v-model="form" />
        <UAlert v-if="add.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(add.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="add.isPending.value">{{ t('agencies.addUser') }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="add.isPending.value" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
