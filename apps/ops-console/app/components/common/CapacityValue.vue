<script setup lang="ts">
/** Beds and Haji capacity, always as two labelled numbers (§1.4): "6 Haji, 6 beds" — never one figure. */
defineProps<{ haji: number | null | undefined, beds: number | null | undefined }>()
const { t } = useI18n()
</script>

<template>
  <span v-if="haji !== null && haji !== undefined" class="tabular">{{ t('capacity.pair', { haji: t('capacity.haji', { count: haji }), beds: t('capacity.beds', { count: beds ?? 0 }, beds ?? 0) }) }}</span>
  <span v-else class="text-(--fg-muted)">—</span>
</template>
