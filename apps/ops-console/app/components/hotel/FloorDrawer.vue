<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { createFloorSchema, updateFloorSchema } from '@hajj/contracts/schemas/floor'
import type { FloorListItem, HotelSummary } from '@hajj/contracts/types/hotel'
import type { FormRef } from '../../utils/forms'

/**
 * Add a floor, or edit one (§25): level and label — the label follows the level ("Floor 4") until typed, and is then
 * the API's own default. A floor
 * with rooms keeps its level (changing it would reorder its rooms silently). A level already used is the level
 * field's problem.
 */
const props = defineProps<{ hotel: HotelSummary, floor: FloorListItem | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [FloorListItem] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const formRef = ref<FormRef | null>(null)
const form = ref({ level: 1, label: '' })
const labelTyped = ref(false)
const editing = computed(() => !!props.floor)
const levelLocked = computed(() => (props.floor?.roomCount ?? 0) > 0)
const defaultLabel = (level: number) => (level === 0 ? t('floors.ground') : t('floors.defaultLabel', { n: level }))

watch(open, (isOpen) => {
  if (!isOpen) return
  save.reset()
  labelTyped.value = editing.value
  form.value = props.floor ? { level: props.floor.level, label: props.floor.label } : { level: 1, label: defaultLabel(1) }
})
watch(() => form.value.level, (level) => {
  if (!labelTyped.value) form.value = { ...form.value, label: defaultLabel(level) }
})
const typeLabel = (label: string) => {
  labelTyped.value = true
  form.value = { ...form.value, label }
}
const request = (state: typeof form.value) => (props.floor
  ? { ...(state.level !== props.floor.level ? { level: state.level } : {}), ...(state.label !== props.floor.label ? { label: state.label } : {}) }
  // Untyped, the label is left to the API ("Floor 4", "Ground"): never stored in the language of whoever added it.
  : { level: state.level, label: labelTyped.value ? state.label || undefined : undefined })
const validate = (state: typeof form.value) => validateWith(props.floor ? updateFloorSchema : createFloorSchema, key => t(key), request)(state)
const save = useMutation({
  mutationFn: () => (props.floor
    ? api<FloorListItem>(`/hotels/${props.hotel.id}/floors/${props.floor.id}`, { method: 'PATCH', body: request(form.value) })
    : api<FloorListItem>(`/hotels/${props.hotel.id}/floors`, { method: 'POST', body: request(form.value) })),
  onSuccess: (floor) => {
    open.value = false
    emit('saved', floor)
  },
  onError: (error) => {
    if (toApiError(error).code === 'ALREADY_EXISTS') formRef.value?.setErrors([{ name: 'level', message: t('floors.levelTaken') }], 'level')
  },
})
</script>

<template>
  <USlideover v-model:open="open" :title="editing ? t('floors.edit') : t('floors.addOne')" :description="t('floors.drawerHelp')">
    <template #body>
      <UForm ref="formRef" :state="form" :validate="validate" class="flex flex-col gap-4" @submit="save.mutate()">
        <HotelStamp :hotel="hotel" />
        <UFormField :label="t('floors.level')" :help="levelLocked ? t('floors.levelLocked') : t('floors.levelHelp')" name="level" required>
          <UInputNumber v-model="form.level" :min="-5" :max="200" :disabled="levelLocked" class="w-36" />
        </UFormField>
        <UFormField :label="t('floors.label')" name="label">
          <UInput :model-value="form.label" class="w-full" @update:model-value="value => typeLabel(String(value))" />
        </UFormField>
        <UAlert v-if="save.error.value && toApiError(save.error.value).code !== 'ALREADY_EXISTS'" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(save.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="save.isPending.value">{{ editing ? t('common.save') : t('floors.addOne') }}</UButton>
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
