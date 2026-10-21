<script setup lang="ts">
import type { StayOption } from '@hajj/contracts/types/booking'

/** One complete option (v7 §9.2): its rooms, what stays empty, extra beds, and the price for the whole stay. */
defineProps<{ option: StayOption, index: number, selected?: boolean }>()
defineEmits<{ choose: [] }>()
const { t } = useI18n()
</script>

<template>
  <article class="surface-panel flex flex-col gap-3 p-5" :class="selected ? 'border-(--primary) bg-(--primary-soft)' : ''" :aria-current="selected ? 'true' : undefined">
    <header class="flex flex-wrap items-baseline justify-between gap-2">
      <h3 class="text-subsection">
        {{ t('book.option', { n: index + 1 }) }}
        <UBadge v-if="selected" color="primary" variant="soft" icon="i-lucide-check" class="ms-2 align-middle">{{ t('book.chosen') }}</UBadge>
      </h3>
      <MoneyText :halalas="option.totalHalalas" class="text-section" />
    </header>
    <ul class="flex flex-col gap-1">
      <li v-for="room in option.rooms" :key="room.roomId" class="flex flex-wrap gap-x-2 text-(--fg-muted)">
        <span class="text-(--fg)">{{ t('book.room', { number: room.roomNumber, floor: room.floorLevel }) }}</span>
        <span>· {{ t(`booking.occupancy.${room.occupancy}`) }}</span>
        <span>· {{ t('book.places', room.seats) }}</span>
        <span v-if="room.extraBeds">· {{ t('book.extraBeds', room.extraBeds) }}</span>
      </li>
    </ul>
    <p v-if="option.emptySeats" class="text-small text-(--fg-muted)">{{ t('book.emptyPlaces', option.emptySeats) }}</p>
    <UButton v-if="!selected" class="self-start" @click="$emit('choose')">{{ t('book.choose') }}</UButton>
  </article>
</template>
