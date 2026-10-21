<script setup lang="ts">
/** A stay as people say it (principle 3): "3 nights · 1–4 Jun 2027". */
defineProps<{ checkIn: string, checkOut: string }>()
const format = useFormat()
</script>

<template>
  <span class="tabular">
    {{ $t('common.nights', format.nights(checkIn, checkOut)) }} · {{ format.stay(checkIn, checkOut) }}
  </span>
</template>
