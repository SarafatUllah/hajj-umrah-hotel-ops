<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { agencyUserPasswordSchema } from '@hajj/contracts/schemas/agency'
import type { AgencyUserDto } from '@hajj/contracts/types/agency'
import { heldWhile } from '../../utils/forms'

/**
 * A new password for an agency user who lost theirs (D-P2-25b): staff set it and give it to the user themselves, off
 * the system; every session of the user ends at once. `user` opens it; it keeps its words while it closes.
 */
const props = defineProps<{ agencyId: string, user: AgencyUserDto | null }>()
const emit = defineEmits<{ close: [], done: [AgencyUserDto] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const shown = useLastShown(() => props.user)
const form = ref({ password: '' })
const validate = validateWith(agencyUserPasswordSchema, key => t(key))
const reset = useMutation({
  mutationFn: () => api<AgencyUserDto>(`/agencies/${props.agencyId}/users/${shown.value!.id}/password`, { method: 'POST', body: form.value }),
  onSuccess: user => emit('done', user),
})
watch(() => props.user, (user) => {
  if (!user) return
  form.value = { password: '' }
  reset.reset()
})
</script>

<template>
  <UModal
    v-bind="heldWhile(reset.isPending.value)"
    :open="!!user"
    :title="shown ? t('agencies.password.title', { name: shown.fullName }) : ''"
    :description="t('agencies.password.text')"
    @update:open="value => { if (!value) emit('close') }"
  >
    <template #body>
      <UForm :state="form" :validate="validate" class="flex flex-col gap-4" @submit="reset.mutate()">
        <UFormField :label="t('agencyForm.password')" :help="t('agencyForm.passwordHelp')" name="password" required>
          <UInput v-model="form.password" type="password" autocomplete="new-password" autofocus class="w-full" />
        </UFormField>
        <UAlert v-if="reset.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(reset.error.value)" role="alert" />
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" :disabled="reset.isPending.value" @click="emit('close')">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" :loading="reset.isPending.value">{{ t('agencies.password.action') }}</UButton>
        </div>
      </UForm>
    </template>
  </UModal>
</template>
