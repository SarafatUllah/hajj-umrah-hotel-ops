<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { ROOM_FEATURES, type RoomFeature } from '@hajj/contracts/constants/inventory'
import { createRoomSchema, updateRoomSchema } from '@hajj/contracts/schemas/room'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { RoomDetail } from '@hajj/contracts/types/rooms'
import { normalizeRoomNumber } from '@hajj/contracts/utils/roomNumber'
import { type FormRef, heldWhile, withSaved } from '../../utils/forms'

/**
 * Add one room, or edit a room's details (§27): floor, type, features, notes. The number is set once — on create it
 * is normalized as typed ("٤٠١" reads 401); on edit it shows locked. A new room starts with its type's capacity
 * unless other numbers are set; an existing room's capacity changes only from a date (the room's page).
 */
const props = defineProps<{ hotel: HotelSummary, room: RoomDetail | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [RoomDetail] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const floors = useFloors(() => props.hotel.id)
const types = useRoomTypes()
const floorItems = computed(() => withSaved(floors.items.value, props.room && { value: props.room.floor.id, label: props.room.floor.label }))
const typeItems = computed(() => withSaved(types.items.value, props.room && { value: props.room.roomType.id, label: props.room.roomType.name }))
const formRef = ref<FormRef | null>(null)
const features = computed(() => choiceItems(ROOM_FEATURES, value => t(`rooms.feature.${value}`)))
const form = ref({ floorId: '', roomTypeId: '', roomNumber: '', inServiceFrom: '', ownCapacity: false, physicalBeds: 4, sellableCapacity: 4, features: [] as RoomFeature[], notes: '' })
watch(open, (isOpen) => {
  if (!isOpen) return
  save.reset()
  const room = props.room
  form.value = room
    ? { floorId: room.floor.id, roomTypeId: room.roomType.id, roomNumber: room.roomNumber, inServiceFrom: room.lifecycle.inServiceFrom, ownCapacity: false, physicalBeds: 4, sellableCapacity: 4, features: [...room.features], notes: room.notes ?? '' }
    : { floorId: '', roomTypeId: '', roomNumber: '', inServiceFrom: props.hotel.today, ownCapacity: false, physicalBeds: 4, sellableCapacity: 4, features: [], notes: '' }
})
const normalized = computed(() => normalizeRoomNumber(form.value.roomNumber))
const typeDefaults = computed(() => types.byId(form.value.roomTypeId))

function request(state: typeof form.value) {
  if (!props.room) {
    return {
      floorId: state.floorId, roomTypeId: state.roomTypeId, roomNumber: state.roomNumber, inServiceFrom: state.inServiceFrom, features: state.features, notes: state.notes,
      ...(state.ownCapacity ? { physicalBeds: state.physicalBeds, sellableCapacity: state.sellableCapacity } : {}),
    }
  }
  const before = props.room
  return {
    ...(state.floorId !== before.floor.id ? { floorId: state.floorId } : {}),
    ...(state.roomTypeId !== before.roomType.id ? { roomTypeId: state.roomTypeId } : {}),
    ...([...state.features].sort().join() !== [...before.features].sort().join() ? { features: state.features } : {}),
    ...(state.notes !== (before.notes ?? '') ? { notes: state.notes } : {}),
  }
}
const validate = (state: typeof form.value) => validateWith(props.room ? updateRoomSchema : createRoomSchema, key => t(key), request)(state)
const save = useMutation({
  mutationFn: () => (props.room
    ? api<RoomDetail>(`/hotels/${props.hotel.id}/rooms/${props.room.id}`, { method: 'PATCH', body: request(form.value) })
    : api<RoomDetail>(`/hotels/${props.hotel.id}/rooms`, { method: 'POST', body: request(form.value) })),
  onSuccess: (room) => {
    open.value = false
    emit('saved', room)
  },
  onError: (error) => {
    const code = toApiError(error).code
    if (code === 'ALREADY_EXISTS') formRef.value?.setErrors([{ name: 'roomNumber', message: t('rooms.numberTaken') }], 'roomNumber')
    if (code === 'INVALID_ROOM_NUMBER') formRef.value?.setErrors([{ name: 'roomNumber', message: t('errors.codes.INVALID_ROOM_NUMBER') }], 'roomNumber')
  },
})
const fieldError = computed(() => (save.error.value ? ['ALREADY_EXISTS', 'INVALID_ROOM_NUMBER'].includes(toApiError(save.error.value).code) : false))
</script>

<template>
  <USlideover v-bind="heldWhile(save.isPending.value)" v-model:open="open" :title="room ? t('rooms.editNamed', { room: room.roomNumber }) : t('rooms.addOne')" :description="room ? t('rooms.editHelp') : t('rooms.addOneHelp')">
    <template #body>
      <UForm ref="formRef" :state="form" :validate="validate" class="flex flex-col gap-4" @submit="save.mutate()">
        <HotelStamp :hotel="hotel" />
        <div v-if="room" class="flex flex-col gap-1">
          <span class="text-small font-medium">{{ t('rooms.number') }}</span>
          <span class="flex items-center gap-2 tabular" dir="ltr"><UIcon name="i-lucide-lock" class="size-4 text-(--fg-muted)" />{{ room.roomNumber }}</span>
          <span class="text-small text-(--fg-muted)">{{ t('rooms.numberLocked') }}</span>
        </div>
        <UFormField v-else :label="t('rooms.number')" :help="normalized && normalized !== form.roomNumber.trim() ? t('rooms.numberReads', { number: normalized }) : t('rooms.numberOnce')" name="roomNumber" required>
          <UInput v-model="form.roomNumber" dir="ltr" class="w-40" />
        </UFormField>
        <div class="grid grid-cols-2 gap-4">
          <UFormField :label="t('rooms.floor')" name="floorId" required><USelect v-model="form.floorId" :items="floorItems" class="w-full" /></UFormField>
          <UFormField :label="t('rooms.type')" name="roomTypeId" required><USelect v-model="form.roomTypeId" :items="typeItems" class="w-full" /></UFormField>
        </div>
        <template v-if="!room">
          <UFormField :label="t('rooms.inServiceFrom')" name="inServiceFrom" required><UInput v-model="form.inServiceFrom" type="date" dir="ltr" class="w-44" /></UFormField>
          <USwitch v-model="form.ownCapacity" :label="t('rooms.ownCapacity')" :description="typeDefaults ? t('rooms.typeDefaults', { beds: typeDefaults.defaultPhysicalBeds, haji: typeDefaults.defaultSellableCapacity }) : undefined" />
          <div v-if="form.ownCapacity" class="grid grid-cols-2 gap-4">
            <UFormField :label="t('capacity.bedsLabel')" name="physicalBeds" required><UInputNumber v-model="form.physicalBeds" :min="1" :max="30" class="w-full" /></UFormField>
            <UFormField :label="t('capacity.hajiLabel')" name="sellableCapacity" required><UInputNumber v-model="form.sellableCapacity" :min="0" :max="30" class="w-full" /></UFormField>
          </div>
        </template>
        <UFormField :label="t('rooms.features')" name="features"><UCheckboxGroup v-model="form.features" :items="features" /></UFormField>
        <UFormField :label="t('rooms.notes')" name="notes" :hint="t('common.optional')"><UTextarea v-model="form.notes" :rows="2" class="w-full" /></UFormField>
        <UAlert v-if="save.error.value && !fieldError" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(save.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="save.isPending.value">{{ room ? t('common.save') : t('rooms.addOne') }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="save.isPending.value" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
