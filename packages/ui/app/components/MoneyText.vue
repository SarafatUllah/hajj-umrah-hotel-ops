<script setup lang="ts">
/** Money in halalas as riyals: tabular figures, never truncated. */
defineProps<{ halalas: number }>()
const format = useFormat()
</script>

<template>
  <span class="tabular whitespace-nowrap">{{ format.money(halalas) }}</span>
</template>
