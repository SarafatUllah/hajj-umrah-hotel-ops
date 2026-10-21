<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { reactivateRoomSchema, retireRoomSchema } from '@hajj/contracts/schemas/room'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { BlockListItem, RoomDetail } from '@hajj/contracts/types/rooms'
import { addDays } from '@hajj/contracts/utils/dates'
import { heldWhile } from '../../utils/forms'

/**
 * Retire a room (§28, tier 2) or return it to inventory (tier 1). Retiring first lists what stands in the way, from
 * the room's own data — a season still to come, a block not yet over — each with where to fix it; then "I
 * understand". Its history stays and its number is never given to another room. Returning asks from when and with
 * what capacity.
 */
const props = defineProps<{ hotel: HotelSummary, room: RoomDetail, blocks: BlockListItem[], mode: 'retire' | 'reactivate' | null }>()
const emit = defineEmits<{ done: [RoomDetail], close: [] }>()
const { t } = useI18n()
const api = useApi()
const format = useFormat()
const errorMessage = useErrorMessage()
const form = ref({ effectiveFrom: '', physicalBeds: 4, sellableCapacity: 4, reason: '' })
const understood = ref(false)
/**
 * The first night it can take effect: today at the earliest — retiring after the night the current capacity started,
 * returning after the last night in service (the API's rules, so the form never offers a night it would refuse).
 */
const earliest = computed(() => {
  const last = props.room.baseVersions.at(-1)
  const after = props.mode === 'reactivate'
    ? (props.room.lifecycle.lastNight ? addDays(props.room.lifecycle.lastNight, 1) : props.hotel.today)
    : (last ? addDays(last.validFrom, 1) : props.hotel.today)
  return after > props.hotel.today ? after : props.hotel.today
})
watch(() => props.mode, (mode) => {
  if (!mode) return
  run.reset()
  understood.value = false
  const last = props.room.baseVersions.at(-1)
  form.value = { effectiveFrom: earliest.value, physicalBeds: last?.physicalBeds ?? 4, sellableCapacity: last?.sellableCapacity ?? 4, reason: '' }
})
const base = computed(() => `/hotels/${encodeURIComponent(props.hotel.code)}`)
/** What would stop the retirement on these nights: seasons and blocks that still reach them. */
const blockers = computed(() => (props.mode !== 'retire' || !form.value.effectiveFrom
  ? []
  : [
      ...props.room.seasons.filter(s => s.period.phase !== 'ENDED' && s.period.endDate >= form.value.effectiveFrom)
        .map(s => ({ key: s.overrideId, text: t('rooms.retireSeason', { room: props.room.roomNumber, season: s.period.name }), to: `${base.value}/seasons/${s.period.id}` })),
      ...props.blocks.filter(b => b.cancelAction && b.endDate >= form.value.effectiveFrom)
        .map(b => ({ key: b.id, text: t('rooms.retireBlock', { kind: t(`status.inventory.${b.kind}`), dates: `${format.date(b.startDate, 'short')} – ${format.date(b.endDate)}` }), to: `${base.value}/blocks` })),
    ]))
const request = (state: typeof form.value) => (props.mode === 'retire'
  ? { effectiveFrom: state.effectiveFrom, reason: state.reason.trim() || undefined }
  : { effectiveFrom: state.effectiveFrom, physicalBeds: state.physicalBeds, sellableCapacity: state.sellableCapacity, reason: state.reason.trim() || undefined })
const problems = computed(() => validateWith(props.mode === 'retire' ? retireRoomSchema : reactivateRoomSchema, key => t(key), request)(form.value))
const run = useMutation({
  mutationFn: () => api<RoomDetail>(`/hotels/${props.hotel.id}/rooms/${props.room.id}/${props.mode}`, { method: 'POST', body: request(form.value) }),
  onSuccess: room => emit('done', room),
})
const canConfirm = computed(() => !problems.value.length && (props.mode === 'reactivate' || (understood.value && !blockers.value.length)))
</script>

<template>
  <UModal
    v-bind="heldWhile(run.isPending.value)"
    :open="!!mode"
    :title="mode === 'retire' ? t('rooms.retireTitle', { room: room.roomNumber }) : t('rooms.reactivateTitle', { room: room.roomNumber })"
    :description="mode === 'retire' ? t('rooms.retireHelp') : t('rooms.reactivateHelp')"
    @update:open="value => { if (!value) emit('close') }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <HotelStamp :hotel="hotel" />
        <UFormField :label="mode === 'retire' ? t('rooms.retireFrom') : t('rooms.returnFrom')" name="effectiveFrom" required>
          <UInput v-model="form.effectiveFrom" type="date" :min="earliest" dir="ltr" class="w-44" />
        </UFormField>
        <div v-if="mode === 'reactivate'" class="grid grid-cols-2 gap-4">
          <UFormField :label="t('capacity.bedsLabel')" name="physicalBeds" required><UInputNumber v-model="form.physicalBeds" :min="1" :max="30" class="w-full" /></UFormField>
          <UFormField :label="t('capacity.hajiLabel')" name="sellableCapacity" required><UInputNumber v-model="form.sellableCapacity" :min="0" :max="30" class="w-full" /></UFormField>
        </div>
        <UFormField :label="t('capacity.reason')" name="reason" :hint="t('common.optional')"><UTextarea v-model="form.reason" :rows="2" :maxlength="500" class="w-full" /></UFormField>
        <template v-if="mode === 'retire'">
          <div v-if="blockers.length" class="flex flex-col gap-1 rounded-md bg-(--warning-soft) p-3 text-small" role="alert">
            <p class="font-medium">{{ t('rooms.retireFirst') }}</p>
            <ul class="list-disc ps-4">
              <li v-for="blocker in blockers" :key="blocker.key"><NuxtLink :to="blocker.to" class="hover:underline">{{ blocker.text }}</NuxtLink></li>
            </ul>
          </div>
          <template v-else-if="form.effectiveFrom">
            <p class="text-small">{{ t('rooms.retireConsequence', { room: room.roomNumber, date: format.date(form.effectiveFrom) }) }}</p>
            <UCheckbox v-model="understood" :label="t('rooms.retireUnderstand')" />
          </template>
        </template>
        <UAlert v-if="run.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(run.error.value)" role="alert" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="run.isPending.value" @click="emit('close')">{{ t('common.cancel') }}</UButton>
        <UButton :color="mode === 'retire' ? 'error' : 'primary'" :loading="run.isPending.value" :disabled="!canConfirm" @click="run.mutate()">
          {{ mode === 'retire' ? t('rooms.retireNamed', { room: room.roomNumber }) : t('rooms.reactivateNamed', { room: room.roomNumber }) }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
