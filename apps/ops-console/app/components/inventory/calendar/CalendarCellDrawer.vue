<script setup lang="ts">
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { CalendarRefsDto, CalendarRoomDto } from '@hajj/contracts/types/inventory'

/**
 * One room on one night (§31.4): its status that night with the block's dates and reason, its capacity (both numbers)
 * and where it comes from, its capacity over time, and what to do next — block it from this night, open the room.
 */
const props = defineProps<{ hotel: HotelSummary, room: CalendarRoomDto | null, night: string | null, refs: CalendarRefsDto, canBlock: boolean }>()
const emit = defineEmits<{ close: [], block: [CalendarRoomDto, string] }>()
const { t } = useI18n()
const format = useFormat()
const segment = computed(() => (props.room && props.night ? props.room.segments.find(s => s.from <= props.night! && props.night! <= s.to) : undefined))
const season = computed(() => (segment.value?.periodId ? props.refs.periods[segment.value.periodId] : undefined))
const blocks = computed(() => (segment.value?.blockIds ?? []).flatMap((id) => {
  const block = props.refs.blocks[id]
  return block ? [{ id, ...block }] : []
}))
const canBlockHere = computed(() => props.canBlock && !!props.night && props.night >= props.hotel.today && segment.value?.status !== 'NOT_IN_INVENTORY')
</script>

<template>
  <USlideover :open="!!room && !!night" :title="room ? t('rooms.roomNamed', { room: room.roomNumber }) : ''" :description="night ? format.date(night, 'long') : ''" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <div v-if="room && night && segment" class="flex flex-col gap-5">
        <HotelStamp :hotel="hotel" />
        <p class="text-small text-(--fg-muted)"><bdi>{{ room.roomType.name }}</bdi> · <bdi>{{ room.floor.label }}</bdi></p>
        <div class="flex flex-col gap-2">
          <StatusBadge domain="inventory" :value="segment.status" class="self-start" />
          <p v-if="segment.status === 'MAINTENANCE' && segment.sellable" class="text-small text-(--fg-muted)">{{ t('calendar.maintenanceSellable') }}</p>
          <ul v-if="blocks.length" class="flex flex-col gap-1 text-small">
            <li v-for="block in blocks" :key="block.id">{{ t(`status.inventory.${block.kind}`) }} · <NightsRange :from="block.startDate" :to="block.endDate" /> · <bdi>{{ block.reason }}</bdi></li>
          </ul>
        </div>
        <div v-if="segment.sellableCapacity !== null" class="flex flex-col gap-1">
          <CapacityValue :haji="segment.sellableCapacity" :beds="segment.physicalBeds" class="text-section" />
          <span class="text-small" :class="season ? 'text-(--season)' : 'text-(--fg-muted)'">{{ season ? t('rooms.seasonSource', { season: season.name }) : t('rooms.normalSource') }}</span>
        </div>
        <CapacityTimeline :hotel-id="hotel.id" :room-id="room.roomId" :today="hotel.today" />
        <div class="flex flex-wrap gap-2">
          <UButton v-if="canBlockHere" icon="i-lucide-lock" @click="emit('block', room, night)">{{ t('calendar.blockFrom') }}</UButton>
          <UButton :to="`/hotels/${encodeURIComponent(hotel.code)}/rooms/${room.roomId}`" color="neutral" variant="outline">{{ t('calendar.openRoom') }}</UButton>
        </div>
      </div>
    </template>
  </USlideover>
</template>
