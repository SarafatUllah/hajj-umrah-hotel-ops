<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { agencyStatusChangeSchema } from '@hajj/contracts/schemas/agency'
import type { AgencyDto } from '@hajj/contracts/types/agency'
import type { AgencyDecision } from '../../utils/agencies'
import { heldWhile } from '../../utils/forms'

/** Approve, suspend or reject an agency (v7 §15), with the reason (kept for the staff; an agency not approved gets no price). */
const props = defineProps<{ agency: AgencyDto, decision: AgencyDecision | null }>()
const emit = defineEmits<{ close: [], done: [AgencyDto] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const form = ref({ reason: '' })
/** The decision asked: kept while the dialog closes, so its words do not empty themselves mid-animation. */
const asked = ref<AgencyDecision>('APPROVED')
const validate = validateWith(agencyStatusChangeSchema, key => t(key), (state: typeof form.value) => ({ status: asked.value, reason: state.reason }))
const decide = useMutation({
  mutationFn: () => api<AgencyDto>(`/agencies/${props.agency.id}/status`, { method: 'POST', body: { status: asked.value, reason: form.value.reason.trim() } }),
  onSuccess: agency => emit('done', agency),
})
watch(() => props.decision, (decision) => {
  if (!decision) return
  asked.value = decision
  form.value = { reason: '' }
  decide.reset()
}, { immediate: true })
</script>

<template>
  <UModal
    v-bind="heldWhile(decide.isPending.value)"
    :open="!!decision"
    :title="t(`agencies.decision.${asked}.title`, { name: agency.name })"
    :description="t(`agencies.decision.${asked}.text`)"
    @update:open="value => { if (!value) emit('close') }"
  >
    <template #body>
      <UForm :state="form" :validate="validate" class="flex flex-col gap-4" @submit="decide.mutate()">
        <UFormField :label="t('agencies.reason')" :help="t('agencies.reasonHelp')" name="reason" required>
          <UTextarea v-model="form.reason" :rows="3" :maxlength="500" autofocus class="w-full" />
        </UFormField>
        <UAlert v-if="decide.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(decide.error.value)" role="alert" />
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" :disabled="decide.isPending.value" @click="emit('close')">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" :color="asked === 'APPROVED' ? 'primary' : 'error'" :loading="decide.isPending.value">{{ t(`agencies.decision.${asked}.action`) }}</UButton>
        </div>
      </UForm>
    </template>
  </UModal>
</template>
