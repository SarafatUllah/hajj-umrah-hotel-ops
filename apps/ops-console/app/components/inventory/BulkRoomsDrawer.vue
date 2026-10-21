<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { MAX_BULK_ROOMS } from '@hajj/contracts/constants/inventory'
import { bulkCreateRoomsSchema } from '@hajj/contracts/schemas/room'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { RoomListItem } from '@hajj/contracts/types/rooms'
import { type RoomNumbering, roomNumberPreview } from '../../utils/inventory'
import { heldWhile } from '../../utils/forms'

/**
 * Add rooms in bulk (§27): a floor, a type, the first night in service, and the numbers — a range ("prefix 4, 1 to
 * 10, two digits") or a list pasted one per line — previewed live as they will be stored. All or nothing: numbers
 * that exist already (retired rooms included: numbers are never reused) are marked, and nothing is created.
 */
const props = defineProps<{ hotel: HotelSummary }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [RoomListItem[]] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const floors = useFloors(() => props.hotel.id)
const types = useRoomTypes()
const empty = () => ({ floorId: '', roomTypeId: '', inServiceFrom: props.hotel.today, ownCapacity: false, physicalBeds: 4, sellableCapacity: 4 })
const form = ref(empty())
const numbering = ref<RoomNumbering>({ mode: 'range', prefix: '', from: 1, to: 10, pad: 2, list: '' })
watch(open, (isOpen) => {
  if (!isOpen) return
  save.reset()
  form.value = empty()
  numbering.value = { mode: 'range', prefix: '', from: 1, to: 10, pad: 2, list: '' }
})
const preview = computed(() => roomNumberPreview(numbering.value))
const typeDefaults = computed(() => types.byId(form.value.roomTypeId))
const modes = computed(() => [{ value: 'range', label: t('rooms.byRange') }, { value: 'list', label: t('rooms.byList') }])

function request(state: typeof form.value) {
  const numbers = numbering.value.mode === 'range'
    ? { range: { prefix: numbering.value.prefix || undefined, from: numbering.value.from, to: numbering.value.to, pad: numbering.value.pad || undefined } }
    : { numbers: preview.value.numbers }
  return {
    floorId: state.floorId, roomTypeId: state.roomTypeId, inServiceFrom: state.inServiceFrom, ...numbers,
    ...(state.ownCapacity ? { physicalBeds: state.physicalBeds, sellableCapacity: state.sellableCapacity } : {}),
  }
}
const validate = validateWith(bulkCreateRoomsSchema, key => t(key), request)
const save = useMutation({
  mutationFn: () => api<RoomListItem[]>(`/hotels/${props.hotel.id}/rooms/bulk`, { method: 'POST', body: request(form.value) }),
  onSuccess: (rooms) => {
    open.value = false
    emit('saved', rooms)
  },
})
/** Numbers the API refused: already used at this hotel (409) or repeated in the request (422). */
const refused = computed<string[]>(() => {
  if (!save.error.value) return []
  const error = toApiError(save.error.value)
  return error.detail<string[]>('conflicts') ?? error.detail<string[]>('duplicates') ?? []
})
const tooMany = computed(() => preview.value.requested > MAX_BULK_ROOMS)
// The numbers changed: what the API refused before no longer applies.
watch(numbering, () => { if (save.error.value) save.reset() }, { deep: true })
const canSave = computed(() => preview.value.numbers.length > 0 && !tooMany.value && !preview.value.invalid.length && !preview.value.duplicates.length)
</script>

<template>
  <USlideover v-bind="heldWhile(save.isPending.value)" v-model:open="open" :title="t('rooms.addMany')" :description="t('rooms.addManyHelp')" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <UForm :state="form" :validate="validate" class="flex flex-col gap-4" @submit="save.mutate()">
        <HotelStamp :hotel="hotel" />
        <div class="grid gap-4 sm:grid-cols-3">
          <UFormField :label="t('rooms.floor')" name="floorId" required><USelect v-model="form.floorId" :items="floors.items.value" class="w-full" /></UFormField>
          <UFormField :label="t('rooms.type')" name="roomTypeId" required><USelect v-model="form.roomTypeId" :items="types.items.value" class="w-full" /></UFormField>
          <UFormField :label="t('rooms.inServiceFrom')" name="inServiceFrom" required><UInput v-model="form.inServiceFrom" type="date" dir="ltr" class="w-full" /></UFormField>
        </div>
        <fieldset class="flex flex-col gap-3">
          <legend class="text-subsection mb-1">{{ t('rooms.numbers') }}</legend>
          <URadioGroup v-model="numbering.mode" :items="modes" orientation="horizontal" />
          <div v-if="numbering.mode === 'range'" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <UFormField :label="t('rooms.prefix')" name="range.prefix"><UInput v-model="numbering.prefix" dir="ltr" maxlength="10" class="w-full" /></UFormField>
            <UFormField :label="t('rooms.from')" name="range.from"><UInputNumber v-model="numbering.from" :min="0" :max="999999" class="w-full" /></UFormField>
            <UFormField :label="t('rooms.to')" name="range.to"><UInputNumber v-model="numbering.to" :min="0" :max="999999" class="w-full" /></UFormField>
            <UFormField :label="t('rooms.digits')" name="range.pad"><UInputNumber v-model="numbering.pad" :min="0" :max="10" class="w-full" /></UFormField>
          </div>
          <UFormField v-else :label="t('rooms.list')" :help="t('rooms.listHelp')" name="numbers"><UTextarea v-model="numbering.list" :rows="5" dir="ltr" class="w-full" /></UFormField>
          <div class="surface-panel flex flex-col gap-2 p-3" aria-live="polite">
            <p class="text-small">{{ preview.numbers.length ? t('rooms.preview', preview.numbers.length) : t('rooms.previewNone') }}</p>
            <ul class="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
              <li v-for="number in preview.numbers" :key="number"><UBadge :color="refused.includes(number) ? 'error' : 'neutral'" variant="soft" class="tabular">{{ number }}</UBadge></li>
            </ul>
            <p v-if="preview.invalid.length" class="text-small text-(--danger)">{{ t('rooms.invalidNumbers', { list: preview.invalid.join(', ') }) }}</p>
            <p v-if="preview.duplicates.length" class="text-small text-(--danger)">{{ t('rooms.repeatedNumbers', { list: preview.duplicates.join(', ') }) }}</p>
            <p v-if="tooMany" class="text-small text-(--warning)">{{ t('rooms.tooMany', { max: MAX_BULK_ROOMS }) }}</p>
          </div>
        </fieldset>
        <USwitch v-model="form.ownCapacity" :label="t('rooms.ownCapacity')" :description="typeDefaults ? t('rooms.typeDefaults', { beds: typeDefaults.defaultPhysicalBeds, haji: typeDefaults.defaultSellableCapacity }) : undefined" />
        <div v-if="form.ownCapacity" class="grid grid-cols-2 gap-4">
          <UFormField :label="t('capacity.bedsLabel')" name="physicalBeds" required><UInputNumber v-model="form.physicalBeds" :min="1" :max="30" class="w-full" /></UFormField>
          <UFormField :label="t('capacity.hajiLabel')" name="sellableCapacity" required><UInputNumber v-model="form.sellableCapacity" :min="0" :max="30" class="w-full" /></UFormField>
        </div>
        <UAlert v-if="refused.length" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="t('rooms.numbersTaken', { list: refused.join(', ') }, refused.length)" role="alert" />
        <UAlert v-else-if="save.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(save.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="save.isPending.value" :disabled="!canSave">{{ t('rooms.createMany', { count: preview.numbers.length }, preview.numbers.length) }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="save.isPending.value" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
