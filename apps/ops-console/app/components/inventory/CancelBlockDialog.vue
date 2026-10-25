<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import { cancelRoomBlockSchema } from '@hajj/contracts/schemas/roomBlock'
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { BlockListItem } from '@hajj/contracts/types/rooms'
import { addDays } from '@hajj/contracts/utils/dates'
import { heldWhile } from '../../utils/forms'

/**
 * Cancel a block, or end it early (§32.2, tier 1, a reason required): the server's `cancelAction` decides which —
 * an upcoming block (or one starting tonight) is cancelled whole; a running one keeps its past nights and ends
 * after last night.
 */
const props = defineProps<{ hotel: HotelSummary, block: BlockListItem | null }>()
const emit = defineEmits<{ done: [BlockListItem], close: [] }>()
const { t } = useI18n()
const api = useApi()
const format = useFormat()
const errorMessage = useErrorMessage()
const reason = ref('')
watch(() => props.block, () => {
  reason.value = ''
  cancel.reset()
})
const ending = computed(() => props.block?.cancelAction === 'END_EARLY')
const title = computed(() => (ending.value ? t('blocks.endEarlyTitle', { room: props.block?.room.roomNumber }) : t('blocks.cancelTitle', { room: props.block?.room.roomNumber })))
const description = computed(() => {
  const block = props.block
  if (!block) return ''
  if (ending.value) return t('blocks.endEarlyText', { yesterday: format.date(addDays(props.hotel.today, -1), 'short'), room: block.room.roomNumber, today: format.date(props.hotel.today, 'short') })
  return t('blocks.cancelText', { room: block.room.roomNumber, dates: `${format.date(block.startDate, 'short')} – ${format.date(block.endDate)}` })
})
const problems = computed(() => validateWith(cancelRoomBlockSchema, key => t(key))({ reason: reason.value }))
const cancel = useMutation({
  mutationFn: () => api<BlockListItem>(`/hotels/${props.hotel.id}/room-blocks/${props.block!.id}/cancel`, { method: 'POST', body: { reason: reason.value } }),
  onSuccess: block => emit('done', block),
})
</script>

<template>
  <UModal v-bind="heldWhile(cancel.isPending.value)" :open="!!block" :title="title" :description="description" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <div class="flex flex-col gap-3">
        <HotelStamp :hotel="hotel" />
        <UFormField :label="t('blocks.reason')" name="reason" required :error="reason && problems.length ? problems[0]!.message : undefined">
          <UTextarea v-model="reason" :rows="2" :maxlength="500" class="w-full" autofocus />
        </UFormField>
        <UAlert v-if="cancel.error.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :title="errorMessage(cancel.error.value)" role="alert" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="cancel.isPending.value" @click="emit('close')">{{ t('common.cancel') }}</UButton>
        <UButton color="error" :loading="cancel.isPending.value" :disabled="problems.length > 0" @click="cancel.mutate()">{{ ending ? t('blocks.endEarly') : t('blocks.cancelBlock') }}</UButton>
      </div>
    </template>
  </UModal>
</template>
