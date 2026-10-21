<script setup lang="ts">
import type { HotelSummary } from '@hajj/contracts/types/hotel'
import type { OccupancyClaimDto, OccupancyRoomDto } from '@hajj/contracts/types/occupancy'
import { bookerName } from '../../utils/occupancy'

/**
 * One room on one night (v7 §14 "click a room"): its type and state, then each booking sleeping there — number,
 * who booked, group or family, the stay, places and extra beds — and its pilgrims (name, details complete or not,
 * arrived or not). Empty places of a group's room stay that agency's for the same dates. Opens the booking.
 */
const props = defineProps<{ hotel: HotelSummary, date: string, room: OccupancyRoomDto | null }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const format = useFormat()
const whoBooked = (claim: OccupancyClaimDto) => bookerName(claim.booker, { individual: t('bookings.individual'), agency: t('bookings.agency') })
const free = computed(() => (props.room ? Math.max(0, props.room.capacity - props.room.booked - props.room.held) : 0))
</script>

<template>
  <USlideover :open="!!room" :title="room ? t('rooms.roomNamed', { room: room.roomNumber }) : ''" :description="format.date(date, 'long')" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <div v-if="room" class="flex flex-col gap-5">
        <HotelStamp :hotel="hotel" />
        <p class="text-small text-(--fg-muted)"><bdi>{{ room.roomType.name }}</bdi> · {{ t(`occupancy.state.${room.state}`) }} · {{ t('occupancy.placesTaken', { taken: room.booked + room.held, places: room.capacity }) }}</p>
        <p v-if="!room.claims.length" class="text-(--fg-muted)">{{ t('occupancy.noBooking') }}</p>
        <section v-for="claim in room.claims" :key="claim.bookingId" class="surface-panel flex flex-col gap-2 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <NuxtLink :to="`/bookings/${claim.bookingId}`" class="font-semibold tabular hover:underline" dir="ltr">{{ claim.bookingNo }}</NuxtLink>
            <StatusBadge domain="booking" :value="claim.status" />
          </div>
          <p class="text-small"><bdi>{{ whoBooked(claim) }}</bdi> · {{ t(`booking.type.${claim.bookingType}`) }} · {{ t(`booking.occupancy.${claim.occupancy}`) }}</p>
          <p class="text-small text-(--fg-muted)"><StayDates :check-in="claim.checkIn" :check-out="claim.checkOut" /><template v-if="claim.extraBeds"> · {{ t('stay.extraBeds', { count: claim.extraBeds }, claim.extraBeds) }}</template></p>
          <ol class="flex flex-col divide-y divide-(--border) text-small">
            <li v-for="guest in claim.guests" :key="guest.guestId" class="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span><bdi>{{ guest.name ?? t('guest.place', { n: guest.slotNo }) }}</bdi> <span class="text-(--fg-muted)">· {{ t(`booking.ageGroup.${guest.ageGroup}`) }}</span></span>
              <StatusBadge domain="guest" :value="guest.status" />
            </li>
          </ol>
          <UButton :to="`/bookings/${claim.bookingId}`" size="sm" color="neutral" variant="outline" class="self-start">{{ t('occupancy.openBooking') }}</UButton>
        </section>
        <p v-if="free && room.claims.some(c => c.bookingType === 'GROUP' && c.booker.agencyId)" class="text-small text-(--fg-muted)">{{ t('occupancy.groupFree', { count: free }, free) }}</p>
      </div>
    </template>
  </USlideover>
</template>
