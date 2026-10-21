<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { changeBaseConfigSchema } from '@hajj/contracts/schemas/room'
import type { BookingMisfit } from '@hajj/contracts/types/booking'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { RoomDetail } from '@hajj/contracts/types/rooms'
import { addDays } from '@hajj/contracts/utils/dates'
import { heldWhile } from '../../utils/forms'

/**
 * Change a room's normal capacity from a date (§28): a permanent change, today or later — past nights are history.
 * The line before saving says what becomes what; seasons already set up keep their own numbers.
 */
const props = defineProps<{ hotel: HotelSummary, room: RoomDetail }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [RoomDetail] }>()
const { t } = useI18n()
const api = useApi()
const format = useFormat()
const errorMessage = useErrorMessage()
const form = ref({ effectiveFrom: '', physicalBeds: 4, sellableCapacity: 4, reason: '' })
/** The first night a change can start: today, and after the night the current capacity started. */
const earliest = computed(() => {
  const current = props.room.baseVersions.at(-1)
  const afterCurrent = current ? addDays(current.validFrom, 1) : props.hotel.today
  return afterCurrent > props.hotel.today ? afterCurrent : props.hotel.today
})
watch(open, (isOpen) => {
  if (!isOpen) return
  save.reset()
  form.value = { effectiveFrom: earliest.value, physicalBeds: props.room.base?.physicalBeds ?? 4, sellableCapacity: props.room.base?.sellableCapacity ?? 4, reason: '' }
})
const request = (state: typeof form.value) => ({ ...state, reason: state.reason.trim() || undefined })
const validate = validateWith(changeBaseConfigSchema, key => t(key), request)
const save = useMutation({
  mutationFn: () => api<RoomDetail>(`/hotels/${props.hotel.id}/rooms/${props.room.id}/base-config`, { method: 'POST', body: request(form.value) }),
  onSuccess: (room) => {
    open.value = false
    emit('saved', room)
  },
})
const misfits = computed(() => (save.error.value ? [...new Set((toApiError(save.error.value).detail<BookingMisfit[]>('bookings') ?? []).map(b => b.bookingNo))] : []))
</script>

<template>
  <USlideover v-bind="heldWhile(save.isPending.value)" v-model:open="open" :title="t('capacity.changeTitle', { room: room.roomNumber })" :description="t('capacity.changeHelp')">
    <template #body>
      <UForm :state="form" :validate="validate" class="flex flex-col gap-4" @submit="save.mutate()">
        <HotelStamp :hotel="hotel" />
        <UFormField :label="t('capacity.from')" :help="t('capacity.fromHelp')" name="effectiveFrom" required><UInput v-model="form.effectiveFrom" type="date" :min="earliest" dir="ltr" class="w-44" /></UFormField>
        <div class="grid grid-cols-2 gap-4">
          <UFormField :label="t('capacity.bedsLabel')" name="physicalBeds" required><UInputNumber v-model="form.physicalBeds" :min="1" :max="30" class="w-full" /></UFormField>
          <UFormField :label="t('capacity.hajiLabel')" name="sellableCapacity" required><UInputNumber v-model="form.sellableCapacity" :min="0" :max="30" class="w-full" /></UFormField>
        </div>
        <UFormField :label="t('capacity.reason')" name="reason" :hint="t('common.optional')"><UTextarea v-model="form.reason" :rows="2" :maxlength="500" class="w-full" /></UFormField>
        <p v-if="room.base && form.effectiveFrom" class="rounded-md bg-(--surface-2) p-3 text-small" aria-live="polite">
          {{ t('capacity.beforeAfter', { date: format.date(form.effectiveFrom), beds: room.base.physicalBeds, haji: room.base.sellableCapacity, newBeds: form.physicalBeds, newHaji: form.sellableCapacity }) }}
        </p>
        <UAlert v-if="save.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(save.error.value)" :description="misfits.length ? t('settings.conflictingBookings', { list: misfits.join(', ') }) : undefined" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="save.isPending.value">{{ t('capacity.save') }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="save.isPending.value" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
