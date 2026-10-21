<script setup lang="ts">
import type { NextChangeDto } from '@hajj/contracts/types/rooms'

/** A room's next change (§27, S5): "1 May 2027: 6 Haji, 6 beds (Hajj 2027)", "1 Oct 2026: retires", or "—". */
defineProps<{ change: NextChangeDto | null }>()
const { t } = useI18n()
const format = useFormat()
</script>

<template>
  <span v-if="!change" class="text-(--fg-muted)">—</span>
  <span v-else-if="change.kind === 'LEAVES_INVENTORY'" class="text-small">{{ format.date(change.date) }}: {{ t('rooms.retires') }}</span>
  <span v-else class="text-small">
    {{ format.date(change.date) }}: <CapacityValue :haji="change.capacity.sellableCapacity" :beds="change.capacity.physicalBeds" />
    <template v-if="change.capacity.period"> (<bdi>{{ change.capacity.period.name }}</bdi>)</template>
    <template v-else-if="change.kind === 'ENTERS_INVENTORY'"> ({{ t('rooms.entersInventory') }})</template>
  </span>
</template>
