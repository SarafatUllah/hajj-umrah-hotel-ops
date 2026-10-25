<script setup lang="ts">
import { hotelMarker } from '../utils/hotelMarker'

/** A hotel's monogram tile (§6.5): it only speeds recognition — the name is always shown beside it. */
const props = defineProps<{ hotel: { id: string, code: string }, size?: 'sm' | 'md' }>()
const marker = computed(() => hotelMarker(props.hotel))
</script>

<template>
  <span
    aria-hidden="true"
    class="inline-flex shrink-0 items-center justify-center rounded-md font-semibold tabular"
    :class="size === 'sm' ? 'size-6 text-[11px]' : 'size-8 text-caption'"
    :style="{ background: `var(--marker-${marker.hue})`, color: 'var(--marker-fg)' }"
  >{{ marker.monogram }}</span>
</template>
