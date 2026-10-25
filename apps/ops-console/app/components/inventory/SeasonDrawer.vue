<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { CAPACITY_PERIOD_KINDS, type CapacityPeriodKind } from '@hajj/contracts/constants/inventory'
import { createCapacityPeriodSchema, updateCapacityPeriodSchema } from '@hajj/contracts/schemas/capacityPeriod'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { CapacityPeriodDto } from '@hajj/contracts/types/inventory'
import { addDays, rangeLength } from '@hajj/contracts/utils/dates'
import { type FormRef, heldWhile } from '../../utils/forms'

/**
 * A new season, or a season's details (§30.2, §30.4): name (unique at the hotel), label (for grouping only), first
 * and last night, notes. What may change follows its phase: an upcoming season everything, a running one its name,
 * notes and end (yesterday at the earliest), an ended one its name and notes. Dates are set, never derived.
 */
const props = defineProps<{ hotel: HotelSummary, season: CapacityPeriodDto | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [CapacityPeriodDto] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const formRef = ref<FormRef | null>(null)
const kinds = computed(() => choiceItems(CAPACITY_PERIOD_KINDS, value => t(`seasons.kind.${value}`)))
const form = ref({ name: '', kind: 'HAJJ' as CapacityPeriodKind, startDate: '', endDate: '', notes: '' })
watch(open, (isOpen) => {
  if (!isOpen) return
  save.reset()
  const season = props.season
  form.value = season
    ? { name: season.name, kind: season.kind, startDate: season.startDate, endDate: season.endDate, notes: season.notes ?? '' }
    : { name: '', kind: 'HAJJ', startDate: '', endDate: '', notes: '' }
})
const phase = computed(() => props.season?.phase ?? 'FUTURE')
const nights = computed(() => (form.value.startDate && form.value.endDate && form.value.endDate >= form.value.startDate ? rangeLength({ from: form.value.startDate, to: form.value.endDate }) : 0))
const startsInPast = computed(() => !props.season && !!form.value.startDate && form.value.startDate < props.hotel.today)
function request(state: typeof form.value) {
  if (!props.season) return { name: state.name, kind: state.kind, startDate: state.startDate, endDate: state.endDate, notes: state.notes }
  const before = props.season
  const changes: Record<string, unknown> = {}
  if (state.name !== before.name) changes.name = state.name
  if (state.notes !== (before.notes ?? '')) changes.notes = state.notes
  if (phase.value !== 'ENDED' && state.endDate !== before.endDate) changes.endDate = state.endDate
  if (phase.value === 'FUTURE') {
    if (state.kind !== before.kind) changes.kind = state.kind
    if (state.startDate !== before.startDate) changes.startDate = state.startDate
  }
  return changes
}
const validate = (state: typeof form.value) => validateWith(props.season ? updateCapacityPeriodSchema : createCapacityPeriodSchema, key => t(key), request)(state)
const save = useMutation({
  mutationFn: () => (props.season
    ? api<CapacityPeriodDto>(`/hotels/${props.hotel.id}/capacity-periods/${props.season.id}`, { method: 'PATCH', body: request(form.value) })
    : api<CapacityPeriodDto>(`/hotels/${props.hotel.id}/capacity-periods`, { method: 'POST', body: request(form.value) })),
  onSuccess: (season) => {
    open.value = false
    emit('saved', season)
  },
  onError: (error) => {
    if (toApiError(error).code === 'ALREADY_EXISTS') formRef.value?.setErrors([{ name: 'name', message: t('seasons.nameTaken') }], 'name')
  },
})
const minEnd = computed(() => (phase.value === 'ACTIVE' ? addDays(props.hotel.today, -1) : form.value.startDate || undefined))
</script>

<template>
  <USlideover v-bind="heldWhile(save.isPending.value)" v-model:open="open" :title="season ? t('seasons.edit', { name: season.name }) : t('seasons.new')" :description="t('seasons.labelHelp')">
    <template #body>
      <UForm ref="formRef" :state="form" :validate="validate" class="flex flex-col gap-4" @submit="save.mutate()">
        <HotelStamp :hotel="hotel" />
        <UFormField :label="t('seasons.name')" :help="t('seasons.nameHelp')" name="name" required><UInput v-model="form.name" class="w-full" /></UFormField>
        <UFormField :label="t('seasons.label')" name="kind" required><URadioGroup v-model="form.kind" :items="kinds" orientation="horizontal" :disabled="phase !== 'FUTURE'" /></UFormField>
        <div class="grid grid-cols-2 gap-4">
          <UFormField :label="t('blocks.firstNight')" name="startDate" required><UInput v-model="form.startDate" type="date" dir="ltr" :disabled="phase !== 'FUTURE'" class="w-full" /></UFormField>
          <UFormField :label="t('blocks.lastNight')" name="endDate" required><UInput v-model="form.endDate" type="date" dir="ltr" :min="minEnd" :disabled="phase === 'ENDED'" class="w-full" /></UFormField>
        </div>
        <p v-if="nights" class="text-small text-(--fg-muted)">{{ t('common.nights', nights) }}</p>
        <UAlert v-if="startsInPast" color="warning" variant="soft" icon="i-lucide-history" :title="t('seasons.pastStart')" />
        <UFormField :label="t('seasons.notes')" name="notes" :hint="t('common.optional')"><UTextarea v-model="form.notes" :rows="2" class="w-full" /></UFormField>
        <UAlert v-if="save.error.value && toApiError(save.error.value).code !== 'ALREADY_EXISTS'" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(save.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="save.isPending.value">{{ season ? t('common.save') : t('seasons.create') }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="save.isPending.value" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
