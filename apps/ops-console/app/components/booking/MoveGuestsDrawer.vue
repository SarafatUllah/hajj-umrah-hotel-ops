<script setup lang="ts">
import { keepPreviousData, useMutation } from '@tanstack/vue-query'
import { GUEST_TO_COME_STATUSES } from '@hajj/contracts/constants/booking'
import { moveGuestsSchema } from '@hajj/contracts/schemas/booking'
import type { BookingDetailDto, GuestSlotDto } from '@hajj/contracts/types/booking'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { RoomListPage } from '@hajj/contracts/types/rooms'
import { addDays, maxIsoDate } from '@hajj/contracts/utils/dates'
import { SEARCH_DELAY_MS, useDebounced } from '../../composables/useDebounced'
import { type Choice, heldWhile, withSaved } from '../../utils/forms'

/**
 * Move pilgrims to another room (v7 §12: maintenance, a complaint, an inventory change): the one asked for, and any
 * others of the same side in that room; the room found by number; the first night in the new room — today or later,
 * during the stay. The API checks the room's owner, side and seats.
 */
const props = defineProps<{ booking: BookingDetailDto, hotel: HotelSummary, guests: GuestSlotDto[], guest: GuestSlotDto | null }>()
const emit = defineEmits<{ close: [], done: [roomNumber: string] }>()
const { t } = useI18n()
const api = useApi()
const errorMessage = useErrorMessage()
const MOVABLE: readonly string[] = [...GUEST_TO_COME_STATUSES, 'CHECKED_IN']
const PICKER_SIZE = 50

const firstNight = computed(() => maxIsoDate(props.hotel.today, props.booking.checkIn))
const lastNight = computed(() => addDays(props.booking.checkOut, -1))
/** Who may move with the one asked for: still in the stay, in the same room, on the same side (a group's rooms are one side each). */
const roommates = computed(() => (props.guest
  ? props.guests.filter(g => MOVABLE.includes(g.status) && g.roomNumber === props.guest!.roomNumber && (props.booking.bookingType !== 'GROUP' || g.gender === props.guest!.gender))
  : []))
const chosen = ref<Set<string>>(new Set())
const form = ref({ roomId: '', from: '' })
const roomSearch = ref('')
const roomTerm = useDebounced(() => roomSearch.value.trim(), SEARCH_DELAY_MS)
const rooms = useApiQuery(
  () => ['rooms', props.hotel.id, 'move-picker', roomTerm.value, form.value.from],
  () => api<RoomListPage>(`/hotels/${props.hotel.id}/rooms`, { query: { inventory: 'IN', asOf: form.value.from || undefined, q: roomTerm.value || undefined, pageSize: PICKER_SIZE } }),
  { enabled: computed(() => !!props.guest), placeholderData: keepPreviousData },
)
const found = computed(() => (rooms.data.value?.items ?? []).filter(r => r.roomNumber !== props.guest?.roomNumber).map(r => ({
  value: r.id,
  label: r.roomNumber,
  description: [r.roomType.name, r.effective ? t('capacity.haji', { count: r.effective.sellableCapacity }) : ''].filter(Boolean).join(' · '),
})))
// The room chosen stays choosable (and named) whatever is searched for next.
const picked = ref<Choice | null>(null)
const roomItems = computed(() => withSaved(found.value, picked.value))
function pickRoom(roomId: string): void {
  form.value = { ...form.value, roomId }
  picked.value = found.value.find(r => r.value === roomId) ?? picked.value
}

const body = () => ({ guestIds: [...chosen.value], roomId: form.value.roomId, from: form.value.from || undefined })
const validate = validateWith(moveGuestsSchema, key => t(key), () => body())
const move = useMutation({
  mutationFn: () => api<BookingDetailDto>(`/bookings/${props.booking.id}/guests/move`, { method: 'POST', body: moveGuestsSchema.parse(body()) }),
  onSuccess: () => emit('done', picked.value?.label ?? ''),
})
watch(() => props.guest, (guest) => {
  if (!guest) return
  chosen.value = new Set([guest.id])
  form.value = { roomId: '', from: firstNight.value }
  picked.value = null
  roomSearch.value = ''
  move.reset()
})
function toggle(id: string, on: boolean): void {
  const next = new Set(chosen.value)
  if (on) next.add(id)
  else next.delete(id)
  chosen.value = next
}
</script>

<template>
  <USlideover
    v-bind="heldWhile(move.isPending.value)"
    :open="!!guest"
    :title="t('pilgrims.moveTitle')"
    :description="t('pilgrims.moveHelp')"
    @update:open="value => { if (!value) emit('close') }"
  >
    <template #body>
      <UForm v-if="guest" :state="form" :validate="validate" class="flex flex-col gap-5" @submit="move.mutate()">
        <HotelStamp :hotel="hotel" />
        <fieldset class="flex flex-col gap-2">
          <legend class="text-subsection mb-1">{{ t('pilgrims.moveWho', { room: guest.roomNumber ?? '' }) }}</legend>
          <UCheckbox
            v-for="slot in roommates"
            :key="slot.id"
            :model-value="chosen.has(slot.id)"
            :label="slot.details ? `${slotLabel(slot, t)} · ${slot.details.fullName}` : slotLabel(slot, t)"
            @update:model-value="value => toggle(slot.id, !!value)"
          />
        </fieldset>
        <UFormField :label="t('pilgrims.moveTo')" name="roomId" required>
          <USelectMenu
            v-model:search-term="roomSearch"
            :model-value="form.roomId || undefined"
            :items="roomItems"
            value-key="value"
            ignore-filter
            :loading="rooms.isFetching.value"
            :search-input="{ placeholder: t('rooms.search') }"
            :aria-label="t('pilgrims.moveTo')"
            class="w-full"
            @update:model-value="pickRoom"
          />
        </UFormField>
        <UFormField :label="t('pilgrims.moveFrom')" :help="t('pilgrims.moveFromHelp')" name="from">
          <UInput v-model="form.from" type="date" :min="firstNight" :max="lastNight" dir="ltr" class="w-48" />
        </UFormField>
        <UAlert v-if="move.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(move.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="move.isPending.value" :disabled="!chosen.size || !form.roomId">{{ t('pilgrims.moveSubmit', { count: chosen.size }, chosen.size) }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="move.isPending.value" @click="emit('close')">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
