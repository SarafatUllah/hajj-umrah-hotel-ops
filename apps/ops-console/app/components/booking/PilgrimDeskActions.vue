<script setup lang="ts">
import type { GuestActions } from '../../utils/booking'

/** One pilgrim's buttons at the desk (the booking page's pilgrims panel): only what `offer` allows, each named for assistive technology. */
/** `busy`: a move at the desk is under way (one at a time: the booking's status follows each). */
defineProps<{ offer: GuestActions, name: string, checkingIn: boolean, busy: boolean }>()
const emit = defineEmits<{ checkIn: [], checkOut: [], move: [], noShow: [], remove: [] }>()
const { t } = useI18n()
</script>

<template>
  <UButton v-if="offer.checkIn" size="sm" :disabled="busy" icon="i-lucide-log-in" :loading="checkingIn" :aria-label="t('desk.checkInNamed', { name })" @click="emit('checkIn')">{{ t('desk.checkIn') }}</UButton>
  <span v-else-if="offer.detailsNeeded" class="text-small text-(--fg-muted)">{{ t('desk.detailsFirst') }}</span>
  <UButton v-if="offer.checkOut" size="sm" :disabled="busy" color="neutral" variant="outline" icon="i-lucide-log-out" :aria-label="t('desk.checkOutNamed', { name })" @click="emit('checkOut')">{{ t('desk.checkOut') }}</UButton>
  <UButton v-if="offer.move" size="sm" :disabled="busy" color="neutral" variant="ghost" icon="i-lucide-arrow-right-left" :aria-label="t('pilgrims.moveNamed', { name })" @click="emit('move')">{{ t('pilgrims.move') }}</UButton>
  <UButton v-if="offer.noShow" size="sm" :disabled="busy" color="neutral" variant="ghost" :aria-label="t('desk.noShowNamed', { name })" @click="emit('noShow')">{{ t('desk.noShow') }}</UButton>
  <UButton v-if="offer.remove" size="sm" :disabled="busy" color="error" variant="ghost" :aria-label="t('pilgrims.removeNamed', { name })" @click="emit('remove')">{{ t('pilgrims.remove') }}</UButton>
</template>
