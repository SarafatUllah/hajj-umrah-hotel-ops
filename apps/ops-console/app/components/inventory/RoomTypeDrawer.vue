<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { createRoomTypeSchema, updateRoomTypeSchema } from '@hajj/contracts/schemas/roomType'
import type { RoomTypeListItem } from '@hajj/contracts/types/hotel'
import type { FormRef } from '../../utils/forms'

/**
 * Add or edit a room type (§26). The rule this drawer makes impossible to miss: defaults apply to new rooms only —
 * existing rooms keep their capacity (said above the defaults, again under them once changed, and in the toast).
 */
const props = defineProps<{ roomType: RoomTypeListItem | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [RoomTypeListItem, boolean] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const formRef = ref<FormRef | null>(null)
const empty = () => ({ code: '', name: '', description: '', defaultPhysicalBeds: 4, defaultSellableCapacity: 4, sortOrder: 0 })
const form = ref(empty())
watch(open, (isOpen) => {
  if (!isOpen) return
  save.reset()
  const type = props.roomType
  form.value = type ? { code: type.code, name: type.name, description: type.description ?? '', defaultPhysicalBeds: type.defaultPhysicalBeds, defaultSellableCapacity: type.defaultSellableCapacity, sortOrder: type.sortOrder } : empty()
})
const defaultsChanged = computed(() => !!props.roomType && (form.value.defaultPhysicalBeds !== props.roomType.defaultPhysicalBeds || form.value.defaultSellableCapacity !== props.roomType.defaultSellableCapacity))
/** Create: everything (an empty description is none). Edit: only what changed — an emptied description is cleared. */
function request(state: typeof form.value) {
  const body = { ...state, code: state.code.trim().toUpperCase(), description: state.description.trim() || null }
  const before = props.roomType
  if (!before) return { ...body, description: body.description ?? undefined }
  return Object.fromEntries(Object.entries(body).filter(([key, value]) => value !== before[key as keyof RoomTypeListItem]))
}
const validate = (state: typeof form.value) => validateWith(props.roomType ? updateRoomTypeSchema : createRoomTypeSchema, key => t(key), request)(state)
const save = useMutation({
  mutationFn: () => (props.roomType
    ? api<RoomTypeListItem>(`/room-types/${props.roomType.id}`, { method: 'PATCH', body: request(form.value) })
    : api<RoomTypeListItem>('/room-types', { method: 'POST', body: request(form.value) })),
  onSuccess: (saved) => {
    const changedDefaults = defaultsChanged.value
    open.value = false
    emit('saved', saved, changedDefaults)
  },
  onError: (error) => {
    if (toApiError(error).code === 'ALREADY_EXISTS') formRef.value?.setErrors([{ name: 'code', message: t('roomTypes.codeTaken') }], 'code')
  },
})
</script>

<template>
  <USlideover v-model:open="open" :title="roomType ? t('roomTypes.edit', { name: roomType.name }) : t('roomTypes.add')" :description="t('roomTypes.shared')">
    <template #body>
      <UForm ref="formRef" :state="form" :validate="validate" class="flex flex-col gap-4" @submit="save.mutate()">
        <UFormField :label="t('roomTypes.name')" name="name" required><UInput v-model="form.name" class="w-full" /></UFormField>
        <UFormField :label="t('roomTypes.code')" :help="t('roomTypes.codeHelp')" name="code" required>
          <UInput :model-value="form.code" dir="ltr" class="w-48" @update:model-value="value => form = { ...form, code: String(value).toUpperCase() }" />
        </UFormField>
        <div v-if="roomType" id="defaults-rule" class="flex gap-2 rounded-md bg-(--info-soft) p-3 text-small text-(--info)" role="note">
          <UIcon name="i-lucide-info" class="mt-0.5 size-4 shrink-0" />
          <p><strong>{{ t('roomTypes.ruleTitle') }}</strong> {{ roomType.usageCount !== null ? t('roomTypes.ruleUsage', { count: roomType.usageCount, name: roomType.name }) : t('roomTypes.ruleNoUsage') }}</p>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <UFormField :label="t('roomTypes.beds')" name="defaultPhysicalBeds" required>
            <UInputNumber v-model="form.defaultPhysicalBeds" :min="1" :max="30" aria-describedby="defaults-rule" class="w-full" />
          </UFormField>
          <UFormField :label="t('roomTypes.haji')" :help="t('roomTypes.hajiHelp')" name="defaultSellableCapacity" required>
            <UInputNumber v-model="form.defaultSellableCapacity" :min="0" :max="30" aria-describedby="defaults-rule" class="w-full" />
          </UFormField>
        </div>
        <p v-if="defaultsChanged" class="text-small text-(--fg-muted)" aria-live="polite">{{ t('roomTypes.newDefaults', { name: form.name, beds: form.defaultPhysicalBeds, haji: form.defaultSellableCapacity }) }}</p>
        <UFormField :label="t('roomTypes.description')" name="description" :hint="t('common.optional')"><UTextarea v-model="form.description" :rows="2" class="w-full" /></UFormField>
        <UFormField :label="t('roomTypes.sortOrder')" :help="t('roomTypes.sortOrderHelp')" name="sortOrder"><UInputNumber v-model="form.sortOrder" :min="0" :max="1000" class="w-32" /></UFormField>
        <UAlert v-if="save.error.value && toApiError(save.error.value).code !== 'ALREADY_EXISTS'" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(save.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="save.isPending.value">{{ !roomType ? t('roomTypes.add') : defaultsChanged ? t('roomTypes.saveDefaults') : t('common.save') }}</UButton>
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
