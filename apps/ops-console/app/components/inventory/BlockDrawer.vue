<script setup lang="ts">
import { keepPreviousData, useMutation } from '@tanstack/vue-query'
import type { ResolvedSettings } from '@hajj/contracts/business-rules/hotelSettings'
import { BLOCK_KINDS, type BlockKind, MAX_BULK_ROOMS } from '@hajj/contracts/constants/inventory'
import { createRoomBlockSchema } from '@hajj/contracts/schemas/roomBlock'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { BlockConflict, BlockListItem, RoomListPage } from '@hajj/contracts/types/rooms'
import { addDays, rangeLength } from '@hajj/contracts/utils/dates'
import type { BlockRoom } from '../../utils/inventory'
import { SEARCH_DELAY_MS, useDebounced } from '../../composables/useDebounced'
import { heldWhile } from '../../utils/forms'

/**
 * Block rooms (§32.1): the rooms (prefilled, picked by number, or a whole floor), the kind, the nights (tonight or
 * later) and a reason. A live impact line says what it does; a conflict names the rooms and offers to save the rest.
 * The server decides everything — the impact is presentation arithmetic, labelled "up to".
 */
const props = defineProps<{ hotel: HotelSummary, rooms?: BlockRoom[], startDate?: string, endDate?: string }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [BlockListItem[]] }>()
const { t } = useI18n()
const api = useApi()
const format = useFormat()
const errorMessage = useErrorMessage()
const floors = useFloors(() => props.hotel.id)
const REASONS = ['acRepair', 'plumbing', 'cleaning', 'management', 'staff'] as const
const PICKER_SIZE = 50

const settings = useApiQuery(() => ['hotel-settings', props.hotel.id], () => api<ResolvedSettings>(`/hotels/${props.hotel.id}/settings`), { enabled: open })
// Rooms are found by number on the server: a hotel can have more rooms than one list holds.
const roomSearch = ref('')
const pickerTerm = useDebounced(() => roomSearch.value.trim(), SEARCH_DELAY_MS)
const picker = useApiQuery(
  () => ['rooms', props.hotel.id, 'picker', pickerTerm.value],
  () => api<RoomListPage>(`/hotels/${props.hotel.id}/rooms`, { query: { inventory: 'IN', q: pickerTerm.value || undefined, pageSize: PICKER_SIZE } }),
  { enabled: open, placeholderData: keepPreviousData },
)
const pickable = computed(() => (picker.data.value?.items ?? []).filter(r => !chosen.value.some(c => c.id === r.id)).map(r => ({ value: r.id, label: r.roomNumber })))

const chosen = ref<BlockRoom[]>([])
const wholeFloor = ref(false)
const form = ref({ kind: 'MAINTENANCE' as BlockKind, startDate: '', endDate: '', reason: '', floorId: '' })
watch(open, (isOpen) => {
  if (!isOpen) return
  save.reset()
  roomSearch.value = ''
  chosen.value = [...(props.rooms ?? [])]
  wholeFloor.value = false
  const start = props.startDate ?? props.hotel.today
  form.value = { kind: 'MAINTENANCE', startDate: start, endDate: props.endDate ?? start, reason: '', floorId: '' }
})
function addRoom(roomId: string | null | undefined): void {
  const room = picker.data.value?.items.find(r => r.id === roomId)
  if (room) chosen.value = [...chosen.value, { id: room.id, roomNumber: room.roomNumber, haji: room.effective?.sellableCapacity ?? null }]
}
const removeRoom = (id: string) => { chosen.value = chosen.value.filter(r => r.id !== id) }

const nights = computed(() => (form.value.startDate && form.value.endDate && form.value.endDate >= form.value.startDate ? rangeLength({ from: form.value.startDate, to: form.value.endDate }) : 0))
const stopsSales = computed(() => form.value.kind !== 'MAINTENANCE' || (settings.data.value?.['inventory.maintenanceBlocksSales'] ?? true))
const roomCount = computed(() => (wholeFloor.value ? null : chosen.value.length))
const hajiUpTo = computed(() => chosen.value.reduce((sum, r) => sum + (r.haji ?? 0), 0))
const impact = computed(() => {
  if (!nights.value) return ''
  const dates = `${format.date(form.value.startDate, 'short')} – ${format.date(form.value.endDate)}`
  const forNights = t('common.nights', nights.value)
  if (wholeFloor.value) return t('blocks.impactFloor', { nights: forNights, dates })
  if (!chosen.value.length) return ''
  if (!stopsSales.value) return t('blocks.impactStaysSellable', { count: chosen.value.length, nights: forNights }, chosen.value.length)
  if (chosen.value.length === 1) return t('blocks.impactOne', { room: chosen.value[0]!.roomNumber, nights: forNights, dates })
  return t('blocks.impactMany', { count: chosen.value.length, nights: forNights, roomNights: chosen.value.length * nights.value, haji: hajiUpTo.value }, chosen.value.length)
})
const availableAgain = computed(() => (form.value.endDate ? format.date(addDays(form.value.endDate, 1), 'long') : ''))
const validate = validateWith(createRoomBlockSchema, key => t(key), (state: typeof form.value) => ({ kind: state.kind, startDate: state.startDate, endDate: state.endDate, reason: state.reason }))

const body = () => ({ kind: form.value.kind, startDate: form.value.startDate, endDate: form.value.endDate, reason: form.value.reason })
const save = useMutation({
  mutationFn: async (): Promise<BlockListItem[]> => {
    if (!wholeFloor.value && chosen.value.length === 1) return [await api<BlockListItem>(`/hotels/${props.hotel.id}/rooms/${chosen.value[0]!.id}/blocks`, { method: 'POST', body: body() })]
    const selector = wholeFloor.value ? { floorId: form.value.floorId } : { roomIds: chosen.value.map(r => r.id) }
    return api<BlockListItem[]>(`/hotels/${props.hotel.id}/room-blocks/bulk`, { method: 'POST', body: { ...body(), ...selector } })
  },
  onSuccess: (blocks) => {
    open.value = false
    emit('saved', blocks)
  },
})
/** The rooms a bulk block could not take (409 BLOCK_CONFLICT), to show and to drop. */
const conflicts = computed<BlockConflict[]>(() => (save.error.value ? toApiError(save.error.value).detail<BlockConflict[]>('conflicts') ?? [] : []))
function dropConflicts(): void {
  const ids = new Set(conflicts.value.map(c => c.roomId))
  chosen.value = chosen.value.filter(r => !ids.has(r.id))
  save.reset()
  if (chosen.value.length) save.mutate()
}
const canSave = computed(() => (wholeFloor.value ? !!form.value.floorId : chosen.value.length > 0 && chosen.value.length <= MAX_BULK_ROOMS))
const saveLabel = computed(() => (roomCount.value === null ? t('blocks.blockFloor') : t('blocks.blockCount', { count: roomCount.value }, roomCount.value)))
const kinds = computed(() => BLOCK_KINDS.map(kind => ({
  value: kind,
  label: t(`status.inventory.${kind}`),
  description: kind === 'MAINTENANCE' && !stopsSales.value ? t('blocks.kindHelp.MAINTENANCE_SELLABLE') : t(`blocks.kindHelp.${kind}`),
})))
</script>

<template>
  <USlideover v-bind="heldWhile(save.isPending.value)" v-model:open="open" :title="t('blocks.title')" :description="t('blocks.help')" :ui="{ content: 'max-w-xl' }">
    <template #body>
      <UForm :state="form" :validate="validate" class="flex flex-col gap-5" @submit="save.mutate()">
        <HotelStamp :hotel="hotel" />
        <fieldset class="flex flex-col gap-2">
          <legend class="text-subsection mb-1">{{ t('blocks.rooms') }}</legend>
          <USwitch v-model="wholeFloor" :label="t('blocks.wholeFloor')" />
          <UFormField v-if="wholeFloor" :label="t('rooms.floor')" name="floorId" required>
            <USelect v-model="form.floorId" :items="floors.items.value" class="w-full" />
          </UFormField>
          <template v-else>
            <ul class="flex flex-wrap gap-1" :aria-label="t('blocks.chosen', { count: chosen.length })">
              <li v-for="room in chosen" :key="room.id">
                <UBadge :color="conflicts.some(c => c.roomId === room.id) ? 'error' : 'neutral'" variant="soft" class="tabular">
                  {{ room.roomNumber }}
                  <button type="button" class="ms-1" :aria-label="t('blocks.removeRoom', { room: room.roomNumber })" @click="removeRoom(room.id)"><UIcon name="i-lucide-x" class="size-3" /></button>
                </UBadge>
              </li>
            </ul>
            <!-- Held empty: a picked room joins the list above and the picker is ready for the next one. -->
            <USelectMenu
              v-model:search-term="roomSearch"
              :model-value="null"
              :model-modifiers="{ nullable: true }"
              :items="pickable"
              value-key="value"
              ignore-filter
              :loading="picker.isFetching.value"
              :placeholder="t('blocks.addRoom')"
              :aria-label="t('blocks.addRoom')"
              :search-input="{ placeholder: t('rooms.search') }"
              class="w-full sm:w-64"
              @update:model-value="addRoom"
            />
            <p v-if="chosen.length > MAX_BULK_ROOMS - 20" class="text-small text-(--warning)">{{ t('blocks.limit', { max: MAX_BULK_ROOMS }) }}</p>
          </template>
        </fieldset>
        <UFormField :label="t('blocks.kind')" name="kind" required>
          <URadioGroup v-model="form.kind" :items="kinds" variant="card" />
        </UFormField>
        <div class="grid grid-cols-2 gap-4">
          <UFormField :label="t('blocks.firstNight')" name="startDate" required><UInput v-model="form.startDate" type="date" :min="hotel.today" dir="ltr" class="w-full" /></UFormField>
          <UFormField :label="t('blocks.lastNight')" name="endDate" required><UInput v-model="form.endDate" type="date" :min="form.startDate || hotel.today" dir="ltr" class="w-full" /></UFormField>
        </div>
        <p v-if="nights" class="text-small text-(--fg-muted)">{{ t('blocks.nightsAgain', { nights: t('common.nights', nights), date: availableAgain }) }}</p>
        <UFormField :label="t('blocks.reason')" name="reason" required>
          <UTextarea v-model="form.reason" :rows="2" :maxlength="500" class="w-full" />
          <div class="mt-2 flex flex-wrap gap-1">
            <UButton v-for="reason in REASONS" :key="reason" size="xs" color="neutral" variant="soft" @click="form = { ...form, reason: t(`blocks.reasons.${reason}`) }">{{ t(`blocks.reasons.${reason}`) }}</UButton>
          </div>
        </UFormField>
        <p v-if="impact" class="rounded-md bg-(--surface-2) p-3 text-small" aria-live="polite">{{ impact }}</p>
        <UAlert v-if="conflicts.length" color="error" variant="soft" icon="i-lucide-triangle-alert" role="alert" :title="t('blocks.conflictTitle')">
          <template #description>
            <ul class="list-disc ps-4">
              <li v-for="conflict in conflicts" :key="conflict.roomId">{{ t(`blocks.conflict.${conflict.reason}`, { room: conflict.roomNumber }) }}</li>
            </ul>
            <UButton v-if="conflicts.length < chosen.length" size="sm" color="neutral" variant="outline" class="mt-2" @click="dropConflicts">{{ t('blocks.saveRest') }}</UButton>
          </template>
        </UAlert>
        <UAlert v-else-if="save.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(save.error.value)" role="alert" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="save.isPending.value" :disabled="!canSave">{{ saveLabel }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="save.isPending.value" @click="open = false">{{ t('common.cancel') }}</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>
